// modules/safetyagent/service.js
//
// Runs in the service worker. Pulls one store's CV hazard alerts from SafeIQ
// Studio's SQL endpoint and caches the compact rows in chrome.storage.local
// under "safetyagent.data.<store>". The view does all roll-ups client-side.

import { createAuth, SSO_SELECTORS } from "../../shared/auth.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { getUserHomeStore, getUserHomeStoreSource } from "../../shared/userStore.js";
import { SAFEIQ_ORIGIN, DASHBOARD_PATH, PAGE_SIZE, MAX_PAGES, sqlUrl, hazardSql, compactRow } from "./lib/sql.js";
import { IMAGE_SCHEMA, upgradeImageCache } from "./lib/image_cache.js";
import { singleFlight } from "./lib/single_flight.js";
import { gtaStoreInPage, decodeClocks } from "./lib/gta_store.js";
import { camListUrl, parseCamList } from "./lib/camteams.js";
// Job titles come from the store schedule Digital Metrics already pulls into
// its Firestore (names are encrypted at rest; this read-only import is the
// decrypting reader). Nothing here writes to it.
import { schedules } from "../digitalmetrics/lib/firestore.js";
const authFlight = singleFlight();
const pullFlight = singleFlight();
const oncallFlight = singleFlight();

const MODULE_ID    = "safetyagent";
const TOKEN_KEY    = "safepass.token";            // = module.js webRequestFilters[0].storageKey
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const DATA_KEY     = (store) => `${MODULE_ID}.data.${store}`;
const LAST_STORE_KEY = `${MODULE_ID}.lastStore`;
// Punches + schedule per store-day, for "who was on the clock". PII: local
// only, never synced, pruned past ONCALL_KEEP_DAYS.
const ONCALL_KEY   = (store) => `${MODULE_ID}.oncall.${store}`;
const ONCALL_KEEP_DAYS = 60;
const CAMTEAM_TTL_MS   = 7 * 24 * 60 * 60 * 1000;
const GTA_ORIGIN       = "https://timesheet.cloud.wal-mart.com";

const auth  = createAuth(MODULE_ID);
const token = auth.getCapturedHeader(TOKEN_KEY, TOKEN_TTL_MS);

const SAFEIQ_SSO = [{ text: /continue with sso/i }, ...SSO_SELECTORS];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: MODULE_ID, type, payload }).catch(() => {});
}

async function waitForToken(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = token.get();
    if (t) return t;
    await delay(500);
  }
  return "";
}

// The page only sends the header while it is loading a dashboard, so getting a
// token means: have a SafeIQ tab load the dashboard (reusing the user's own
// tab if one exists — never closing that one), click through SSO if the
// sign-in screen appears, and wait for the shell's webRequest capture.
async function ensureToken() {
  if (token.get()) return token.get();
  return authFlight("safeiq", async () => {
  if (token.get()) return token.get();
  broadcast("progress", { stage: "auth", text: "Signing in to SafeIQ…" });
  // Dedicated owned tab: never borrow a tab another request may close.
  const tab = await chrome.tabs.create({ url: `${SAFEIQ_ORIGIN}${DASHBOARD_PATH}`, active: false });
  try {
    if (await waitForToken(6000)) return token.get();
    if (!await chrome.tabs.get(tab.id).catch(() => null)) throw new Error("SafeIQ sign-in tab was closed. Pull alerts again to retry.");
    await auth.clickSso(tab.id, SAFEIQ_SSO).catch(() => null);
    await waitForToken(45_000);
  const t = token.get();
  if (!t) throw new Error("Could not sign in to SafeIQ. Open the SafeIQ dashboard, sign in, then pull again.");
  return t;
  } finally {
    // Keep an unfinished sign-in available for MFA; close only after capture.
    if (token.get()) await chrome.tabs.remove(tab.id).catch(() => {});
  }
  });
}

async function postSql(sql, page, tok) {
  const res = await fetch(sqlUrl(SAFEIQ_ORIGIN, page, PAGE_SIZE), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json", "x-safepass-token": tok },
    body: JSON.stringify({ sql }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function runSql(sql) {
  let tok = await ensureToken();
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let r = await postSql(sql, page, tok);
    if (r.status === 401) {
      token.clear();
      tok = await ensureToken();
      r = await postSql(sql, page, tok);
    }
    if (r.status !== 200) {
      let msg = r.text.slice(0, 300);
      try { msg = JSON.parse(r.text).message || msg; } catch {}
      throw new Error(`SafeIQ ${r.status}: ${msg}`);
    }
    const j = JSON.parse(r.text);
    const content = j.content || [];
    rows.push(...content);
    broadcast("progress", { stage: "rows", text: `${rows.length} alerts…` });
    if (j.last || content.length < PAGE_SIZE) break;
  }
  return rows;
}

async function resolveStore(msgStore) {
  const s = String(msgStore || "").trim();
  if (/^\d{1,5}$/.test(s)) return { store: s, storeSource: "manual" };
  const { [LAST_STORE_KEY]: last } = await chrome.storage.local.get(LAST_STORE_KEY);
  if (last) return { store: String(last), storeSource: "last" };
  const home = await getUserHomeStore().catch(() => null);
  if (home) return { store: String(home), storeSource: (await getUserHomeStoreSource().catch(() => null)) || "profile" };
  return { store: null, storeSource: null };
}

async function readData(store) {
  if (!store) return null;
  const { [DATA_KEY(store)]: d } = await chrome.storage.local.get(DATA_KEY(store));
  return d || null;
}

// ── handlers ───────────────────────────────────────────────────

async function getState(msg) {
  const { store, storeSource } = await resolveStore(msg?.store);
  const data = await readData(store);
  const upgraded = await upgradeImageCache(data, (query) => pull({ ...query, store }));
  return { store, storeSource, hasToken: !!token.get(), ...upgraded };
}

async function pull(msg) {
  const { store } = await resolveStore(msg?.store);
  if (!store) return { ok: false, error: "No store number. Type one in the toolbar." };
  return pullFlight(JSON.stringify([store, msg?.from || null, msg?.to || null]), () => withKeepAwake(`${MODULE_ID}.pull`, async () => {
    const sql = hazardSql({ store, from: msg?.from || null, to: msg?.to || null });
    const raw = await runSql(sql);
    const rows = raw.map(compactRow);
    const data = { schema: IMAGE_SCHEMA, store, pulledAt: Date.now(), from: msg?.from || null, to: msg?.to || null, rows };
    await chrome.storage.local.set({ [DATA_KEY(store)]: data, [LAST_STORE_KEY]: store });
    return { store, storeSource: "manual", hasToken: !!token.get(), data };
  }));
}

async function openSafeIq() {
  const tab = await chrome.tabs.create({ url: `${SAFEIQ_ORIGIN}${DASHBOARD_PATH}`, active: true });
  return { tabId: tab.id };
}

// ── who was on the clock ───────────────────────────────────────

async function readOncall(store) {
  const { [ONCALL_KEY(store)]: d } = await chrome.storage.local.get(ONCALL_KEY(store));
  return d || { camTeam: null, camAt: 0, teamId: null, days: {} };
}

const localIso = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function fetchCamTeams(store) {
  const res = await fetch(camListUrl(store), {
    credentials: "include", headers: { accept: "application/json;odata=nometadata" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("SharePoint refused the camera list — open teams.wal-mart.com once to sign in, then pull again.");
  if (!res.ok) throw new Error(`SharePoint camera list ${res.status}`);
  const map = parseCamList(await res.json());
  if (!Object.keys(map).length) throw new Error(`The Store Systems camera list has no cameras for store ${store}.`);
  return map;
}

// executeScript into a frozen/discarded tab never settles; bound every call.
async function inGta(tabId, req, ms = 120_000) {
  let timer;
  const run = chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: gtaStoreInPage, args: [req] });
  const res = await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("the timesheet tab did not answer (reload it and pull again)")), ms); })])
    .finally(() => clearTimeout(timer));
  const out = res?.[0]?.result;
  if (!out) throw new Error("the timesheet page did not answer");
  return out;
}

async function gtaTab() {
  const [open] = await chrome.tabs.query({ url: `${GTA_ORIGIN}/*` });
  if (open && !open.discarded) return { tab: open, opened: false };
  const tab = await chrome.tabs.create({ url: `${GTA_ORIGIN}/gtaapp/menu.jsp`, active: false });
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur) throw new Error("the timesheet tab was closed");
    if (cur.status === "complete" && cur.url?.startsWith(GTA_ORIGIN)) return { tab: cur, opened: true };
    await delay(1000);
  }
  chrome.tabs.remove(tab.id).catch(() => {});
  throw new Error("the timesheet needs a sign-in — open timesheet.cloud.wal-mart.com and sign in");
}

async function getOncall(msg) {
  const { store } = await resolveStore(msg?.store);
  if (!store) return { store: null, oncall: null };
  return { store, oncall: await readOncall(store) };
}

/**
 * Fill the store-day cache for every date in msg.dates. A day is (re)pulled
 * when missing, or when it was pulled before the day was over plus a day of
 * slack for punch corrections; everything else is reused.
 */
async function pullOncall(msg) {
  const { store } = await resolveStore(msg?.store);
  if (!store) return { ok: false, error: "No store number. Type one in the toolbar." };
  const dates = [...new Set((msg?.dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  return oncallFlight(store, () => withKeepAwake(`${MODULE_ID}.oncall`, async () => {
    const say = (text) => broadcast("oncall-progress", { text });
    const doc = await readOncall(store);
    const save = () => chrome.storage.local.set({ [ONCALL_KEY(store)]: doc });
    const warnings = [];

    if (!doc.camTeam || Date.now() - doc.camAt > CAMTEAM_TTL_MS || msg?.refreshCams) {
      say("Reading the camera list…");
      try { doc.camTeam = await fetchCamTeams(store); doc.camAt = Date.now(); await save(); }
      catch (e) { if (!doc.camTeam) throw e; warnings.push(`camera list not refreshed: ${e.message}`); }
    }

    const fresh = (iso, at) => at && at > Date.parse(`${iso}T00:00:00`) + 2 * 86_400_000;
    const todo = dates.filter((iso) => !doc.days[iso] || !fresh(iso, doc.days[iso].at));
    if (todo.length) {
      const { tab, opened } = await gtaTab();
      try {
        if (!doc.teamId) {
          say("Finding the store team in the timesheet…");
          const t = await inGta(tab.id, { op: "team", store });
          if (t.error) throw new Error(t.error);
          doc.teamId = t.teamId;
        }
        for (const [i, iso] of todo.entries()) {
          say(`Clock-ins ${i + 1}/${todo.length} · ${iso}`);
          let got = null;
          for (let attempt = 0; attempt < 3 && !got; attempt++) {
            const r = await inGta(tab.id, { op: "day", teamId: doc.teamId, date: iso });
            if (!r.error) got = r;
            else if (!r.drift) throw new Error(r.error);
            else await delay(3000);   // another pull swapped the session's selection; run the day again
          }
          if (!got) { warnings.push(`${iso}: the timesheet kept changing pages — skipped`); continue; }
          const sched = await schedules.get(store, iso).catch(() => null);
          doc.days[iso] = {
            at: Date.now(),
            sched: (sched?.associates || []).map((a) => [a.name, a.jobName || "", a.shiftStart || "", a.shiftEnd || ""]),
            punch: got.rows.map(([name, clocks]) => [name, decodeClocks(clocks, iso).map((p) => [p.kind, p.min, p.code || ""])]),
          };
          await save();
        }
      } finally {
        if (opened) chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
    const cutoff = localIso(Date.now() - ONCALL_KEEP_DAYS * 86_400_000);
    for (const iso of Object.keys(doc.days)) if (iso < cutoff) delete doc.days[iso];
    await save();
    return { store, oncall: doc, pulled: todo.length, warnings };
  }));
}

export const handlers = {
  "get_state":   getState,
  "pull":        pull,
  "open_safeiq": openSafeIq,
  "get_oncall":  getOncall,
  "pull_oncall": pullOncall,
};
