// shared/userStore.js
//
// Single-source-of-truth for the user's home store number and home market,
// derived from their Walmart WIN ID when available. Replaces hardcoded
// "1458" defaults that were scattered through the suite.
//
// STORE sources, in priority order:
//   1. Manual override in chrome.storage.sync["apai.userHomeStoreOverride"]
//      (per-profile, syncs across Edge sign-ins; written by the shell's
//      Settings → Defaults card)
//   2. WIN ID parsed from the Auror JWT identity cached at
//      chrome.storage.local["aurorbuddy.fb_aurorIdentity"].aurorUserId
//      (populated by aurorbuddy/lib/firestore.js::captureAurorIdentityFromJwt
//      on first successful AurorBuddy auth)
//
// WIN ID format observed in Auror sub claims: "samlp|wm-us|<wid>.s<NNNNN>"
// where the trailing 3–5 digits are the user's home store number.
// Example: "samlp|wm-us|ses008s.s01458" → store 1458.
//
// MARKET is override-only (no JWT source). It lives at
// chrome.storage.sync["apai.userHomeMarketOverride"]. When set, market-aware
// modules can call getUserHomeMarketRoster() to get the list of store
// numbers in the market (see shared/marketRoster.js).
//
// Returns null when nothing is available; callers should fall back to a
// "Set your store" UX rather than guessing a default. Works in both
// service-worker and view-page contexts (only uses chrome.storage).
//
// -----------------------------------------------------------------------
// For module authors
// -----------------------------------------------------------------------
// A module wires into the shell defaults with three lines in its view.js
// (or service.js for SW-side reads):
//
//   import { getUserHomeStore, onUserStoreChange } from "../../shared/userStore.js";
//
//   const homeStore = await getUserHomeStore();       // "1458" or null
//   input.value = input.value || homeStore || "";
//
//   const unsub = onUserStoreChange((s) => { /* refresh UI */ });
//   // return unsub from your view's cleanup function
//
// Market-aware modules add:
//
//   import { getUserHomeMarket, getUserHomeMarketRoster } from "../../shared/userStore.js";
//   const market = await getUserHomeMarket();          // "120" or null
//   const roster = await getUserHomeMarketRoster();    // [658, 669, ...] or null
//
// Convention: the shell default is a SEED, not a lock. Once the user has
// explicitly set a value via the module's own UI (e.g. livedashboard's
// storeNbr field), that value wins for that module — the shell default is
// only consulted when the module's own key is empty.

import { getMarketRoster } from "./marketRoster.js";

export const OVERRIDE_KEY = "apai.userHomeStoreOverride";
export const MARKET_OVERRIDE_KEY = "apai.userHomeMarketOverride";
const IDENTITY_KEY = "aurorbuddy.fb_aurorIdentity";

const WID_STORE_RE = /\.s(\d{3,5})\b/i;

export async function getUserHomeStore() {
  const override = await readOverride();
  if (override) return override;

  const identity = await readAurorIdentity();
  const wid = extractWidFromAurorSub(identity.aurorUserId);
  const store = extractStoreFromWid(wid);
  return store || null;
}

export function extractWidFromAurorSub(sub) {
  if (!sub) return "";
  const m = String(sub).match(/\|([^|]+)$/);
  return m ? m[1].trim() : "";
}

export function extractStoreFromWid(wid) {
  if (!wid) return "";
  const m = String(wid).match(WID_STORE_RE);
  return m ? String(parseInt(m[1], 10)) : "";
}

export async function setUserHomeStoreOverride(storeNbr) {
  const v = String(storeNbr ?? "").trim();
  if (!/^\d{1,5}$/.test(v)) throw new Error("Invalid store number");
  await chrome.storage.sync.set({ [OVERRIDE_KEY]: v });
  return v;
}

export async function clearUserHomeStoreOverride() {
  await chrome.storage.sync.remove(OVERRIDE_KEY);
}

// --- Market ---------------------------------------------------------------

export async function getUserHomeMarket() {
  try {
    const got = await chrome.storage.sync.get(MARKET_OVERRIDE_KEY);
    const v = String(got?.[MARKET_OVERRIDE_KEY] ?? "").trim();
    return /^\d{1,3}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export async function setUserHomeMarketOverride(marketNbr) {
  const v = String(marketNbr ?? "").trim();
  if (!/^\d{1,3}$/.test(v)) throw new Error("Invalid market number");
  await chrome.storage.sync.set({ [MARKET_OVERRIDE_KEY]: v });
  return v;
}

export async function clearUserHomeMarketOverride() {
  await chrome.storage.sync.remove(MARKET_OVERRIDE_KEY);
}

export async function getUserHomeMarketRoster() {
  const mkt = await getUserHomeMarket();
  return mkt ? getMarketRoster(mkt) : null;
}

// --- Live-update subscribers ---------------------------------------------
//
// Both wrappers fire when the effective value could have changed. For store
// that means: the override key changed, OR the Auror identity cache changed
// while no override is set. For market that means the market override key
// changed. Callback receives the newly-effective value (or null).

export function onUserStoreChange(cb) {
  const listener = async (changes, areaName) => {
    if (areaName === "sync" && OVERRIDE_KEY in changes) {
      try { cb(await getUserHomeStore()); } catch { /* swallow */ }
      return;
    }
    if (areaName === "local" && IDENTITY_KEY in changes) {
      const override = await readOverride();
      if (!override) {
        try { cb(await getUserHomeStore()); } catch { /* swallow */ }
      }
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function onUserMarketChange(cb) {
  const listener = async (changes, areaName) => {
    if (areaName !== "sync" || !(MARKET_OVERRIDE_KEY in changes)) return;
    try { cb(await getUserHomeMarket()); } catch { /* swallow */ }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// --- internals ------------------------------------------------------------

async function readOverride() {
  try {
    const got = await chrome.storage.sync.get(OVERRIDE_KEY);
    const v = String(got?.[OVERRIDE_KEY] ?? "").trim();
    return /^\d{1,5}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

async function readAurorIdentity() {
  try {
    const got = await chrome.storage.local.get(IDENTITY_KEY);
    return got?.[IDENTITY_KEY] || {};
  } catch {
    return {};
  }
}
