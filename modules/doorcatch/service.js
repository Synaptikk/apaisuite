// modules/doorcatch/service.js
//
// Door Catches — service-worker handlers. The data lives in QRCallBox
// (doorStores/{store}/catches); this module only reads and reviews it.
//
//   get_settings   store, whether a review key is saved, the door link
//   save_settings  { storeNbr, reviewKey, submitKey } (keys stay in this browser)
//   list           { from, to } → catches for the saved store
//   set_review     { id, status: new|reviewed|dismissed, note }
//   set_hosts      { hosts: [name] } → the name list door hosts pick from
//   team           { extra? } → the store's AP team (re-read from WFM schedules
//                  now) plus the hand-kept extra names; `extra` saves that list
//
// Access: a browser with no review key asks QRCallBox for one with the name
// the suite read from the user's Walmart session. It is granted when that
// name is on the store's AP team, which any keyed suite refreshes from the
// last 14 days of WFM schedule job titles (Digital Metrics' import) at most
// every 12 h. A key granted that way is re-checked daily and dropped once the
// person is off the AP team; a pasted key is never re-checked.
//   cached_list    the last list loaded here (instant paint on open)
//   peek_items     { upcs } → cached item details only, no network
//   lookup_items   { upcs, force } → name, brand, category, picture per UPC
//                  (lib/item_lookup.js: go-upc.com, then upcitemdb.com; cached)

import { getUserHomeStore } from "../../shared/userStore.js";
import { getIdentity } from "../../shared/identity.js";
import { doorLink, listCatches, requestAccess, setHosts, setReview, setTeam } from "./lib/api.js";
import { schedules } from "../digitalmetrics/lib/firestore.js";
import { cachedItems, lookupItems } from "./lib/item_lookup.js";

const KEY = "doorcatch.settings";
const LAST_LIST_KEY = "doorcatch.lastList";
const TEAM_SYNC_KEY = "doorcatch.teamSyncAt";
const RECHECK_MS = 24 * 3600_000;
const TEAM_SYNC_MS = 12 * 3600_000;
const AP_JOB = /^AP\b|asset protection/i;

async function settings() {
  const got = (await chrome.storage.local.get(KEY))[KEY] || {};
  const storeNbr = got.storeNbr || String((await getUserHomeStore().catch(() => null)) || "");
  // A saved key for another store is not this store's key.
  const keyed = !got.storeNbr || got.storeNbr === storeNbr;
  return {
    storeNbr,
    reviewKey: keyed ? got.reviewKey || "" : "",
    submitKey: keyed ? got.submitKey || "" : "",
    via: keyed ? got.via || "" : "",          // "ap" = granted by the AP team check
    accessAt: keyed ? got.accessAt || 0 : 0,
    match: keyed ? got.match || null : null,
  };
}

// Ask QRCallBox for the store's keys as an AP associate. Returns the new
// settings, or { error } (a 403 says why; a network failure keeps any old key).
async function apAccess(s) {
  const me = await getIdentity();
  const res = await requestAccess({ storeNbr: s.storeNbr, name: me.displayName || "", win: me.win || "" });
  if (res.ok) {
    const next = { storeNbr: s.storeNbr, reviewKey: res.reviewKey, submitKey: res.submitKey || "", via: "ap", accessAt: Date.now(), match: res.match || null };
    await chrome.storage.local.set({ [KEY]: next });
    return { s: next };
  }
  if (res.status === 403 || res.status === 404) {
    if (s.via === "ap") await chrome.storage.local.set({ [KEY]: { storeNbr: s.storeNbr } });
    return { error: { ok: false, noAccess: true, error: res.error } };
  }
  return s.reviewKey ? { s } : { error: res };
}

// The store's AP associates from the last 14 days of WFM schedules.
async function scheduledApTeam(storeNbr) {
  const found = new Map();
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toLocaleDateString("en-CA");
    const doc = await schedules.get(storeNbr, d).catch(() => null);
    for (const a of doc?.associates || []) {
      if (a.name && AP_JOB.test(a.jobName || "") && !found.has(a.name)) found.set(a.name, a.jobName);
    }
  }
  return [...found].map(([name, jobName]) => ({ name, jobName })).sort((a, b) => a.name.localeCompare(b.name));
}

async function syncTeam(s, extra) {
  const team = await scheduledApTeam(s.storeNbr).catch(() => []);
  const me = await getIdentity();
  const res = await setTeam({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, team, extra, by: me.displayName || me.win || "" });
  if (res.ok) await chrome.storage.local.set({ [TEAM_SYNC_KEY]: { storeNbr: s.storeNbr, at: Date.now() } });
  return res;
}

async function maybeSyncTeam(s) {
  const got = (await chrome.storage.local.get(TEAM_SYNC_KEY))[TEAM_SYNC_KEY];
  if (got?.storeNbr === s.storeNbr && Date.now() - got.at < TEAM_SYNC_MS) return;
  syncTeam(s).catch((err) => console.warn("[doorcatch] team sync failed:", err?.message || err));
}

function publicSettings(s) {
  return {
    ok: true,
    storeNbr: s.storeNbr,
    hasReviewKey: !!s.reviewKey,
    via: s.via || "",
    match: s.match || null,
    doorLink: s.storeNbr && s.submitKey ? doorLink(s.storeNbr, s.submitKey) : "",
  };
}

async function ready() {
  const s = await settings();
  if (!s.storeNbr) return { error: { ok: false, error: "Set the store first." } };
  if (!s.reviewKey || (s.via === "ap" && Date.now() - s.accessAt > RECHECK_MS)) return apAccess(s);
  return { s };
}

export const handlers = {
  async get_settings() {
    return publicSettings(await settings());
  },

  async save_settings(msg) {
    const cur = await settings();
    const next = {
      storeNbr: String(msg.storeNbr ?? cur.storeNbr).trim().replace(/^0+/, ""),
      reviewKey: msg.reviewKey != null && String(msg.reviewKey).trim() ? String(msg.reviewKey).trim() : cur.reviewKey,
      submitKey: msg.submitKey != null && String(msg.submitKey).trim() ? String(msg.submitKey).trim() : cur.submitKey,
    };
    if (next.storeNbr && !/^\d{1,5}$/.test(next.storeNbr)) return { ok: false, error: "Store must be a number." };
    const pasted = msg.reviewKey != null && String(msg.reviewKey).trim();
    if (next.storeNbr !== cur.storeNbr && !pasted) { next.reviewKey = ""; next.submitKey = ""; }
    else if (!pasted && cur.via) Object.assign(next, { via: cur.via, accessAt: cur.accessAt, match: cur.match });
    await chrome.storage.local.set({ [KEY]: next });
    return publicSettings(next);
  },

  async list(msg) {
    const { s, error } = await ready();
    if (error) return error;
    const res = await listCatches({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, from: msg.from, to: msg.to });
    if (res.ok) {
      await chrome.storage.local.set({ [LAST_LIST_KEY]: { storeNbr: s.storeNbr, from: msg.from, to: msg.to, at: Date.now(), res } });
      maybeSyncTeam(s);
    }
    return res;
  },

  // The last list this browser loaded, so the page opens with it instantly
  // while a fresh one is fetched. Only returned for the same store.
  async cached_list() {
    const s = await settings();
    const got = (await chrome.storage.local.get(LAST_LIST_KEY))[LAST_LIST_KEY];
    if (!got || got.storeNbr !== s.storeNbr) return { ok: false };
    return { ok: true, from: got.from, to: got.to, at: got.at, list: got.res };
  },

  async peek_items(msg) {
    return { ok: true, items: await cachedItems(msg.upcs || []) };
  },

  async set_review(msg) {
    const { s, error } = await ready();
    if (error) return error;
    const me = await getIdentity();
    const reviewer = me.displayName || me.win || "";
    return setReview({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, id: msg.id, status: msg.status, note: msg.note || "", reviewer });
  },

  async set_hosts(msg) {
    const { s, error } = await ready();
    if (error) return error;
    return setHosts({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, hosts: msg.hosts || [] });
  },

  async team(msg) {
    const { s, error } = await ready();
    if (error) return error;
    const extra = Array.isArray(msg.extra) ? msg.extra.map((n) => String(n).trim()).filter(Boolean) : undefined;
    return syncTeam(s, extra);
  },

  async lookup_items(msg) {
    const res = await lookupItems(msg.upcs || [], { force: !!msg.force });
    return { ok: true, ...res };
  },
};
