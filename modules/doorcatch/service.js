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
// Access (lib/access.js): AP associates unlock with no key pasted.
//   whoami         looks for the user's name in every source (gscope, Auror),
//                  then asks for AP access with it → { identity, sources, access }
//   cached_list    the last list loaded here (instant paint on open)
//   peek_items     { upcs } → cached item details only, no network
//   lookup_items   { upcs, force } → name, brand, category, picture per UPC
//                  (lib/item_lookup.js: go-upc.com, then upcitemdb.com; cached)

import { getIdentity } from "../../shared/identity.js";
import { checkIdentity } from "../../shared/identity_probe.js";
import { doorLink, listCatches, setHosts, setReview, setTeam } from "./lib/api.js";
import { KEY, apAccess, ready, settings } from "./lib/access.js";
import { schedules } from "../digitalmetrics/lib/firestore.js";
import { cachedItems, lookupItems } from "./lib/item_lookup.js";

const LAST_LIST_KEY = "doorcatch.lastList";
const TEAM_SYNC_KEY = "doorcatch.teamSyncAt";
const TEAM_SYNC_MS = 12 * 3600_000;
const AP_JOB = /^AP\b|asset protection/i;

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
  // "Check who I am": every name source, then a fresh access request with
  // whatever was found (a granted key is saved like any AP unlock).
  async whoami() {
    const check = await checkIdentity();
    const s = await settings();
    let access = null;
    if (s.storeNbr) {
      const got = await apAccess(s);
      const fresh = got.s && got.s.via === "ap" && Date.now() - got.s.accessAt < 60_000;
      access = fresh ? { granted: true, match: got.s.match || null }
        : { granted: false, error: got.error?.error || (got.s ? "Couldn't reach the door catch service. Your saved key still works." : "") };
    }
    return { ok: true, storeNbr: s.storeNbr, identity: { displayName: check.displayName, win: check.win, store: check.store }, sources: check.sources, access };
  },

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
