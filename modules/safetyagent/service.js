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
const authFlight = singleFlight();
const pullFlight = singleFlight();

const MODULE_ID    = "safetyagent";
const TOKEN_KEY    = "safepass.token";            // = module.js webRequestFilters[0].storageKey
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const DATA_KEY     = (store) => `${MODULE_ID}.data.${store}`;
const LAST_STORE_KEY = `${MODULE_ID}.lastStore`;

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

export const handlers = {
  "get_state":   getState,
  "pull":        pull,
  "open_safeiq": openSafeIq,
};
