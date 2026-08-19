// shared/userStore.js
//
// Single-source-of-truth for the user's home store number and home market.
// The store is derived from their Walmart WIN ID when available. Replaces
// the hardcoded "1458" defaults that were scattered through the suite.
//
// The market half has no equivalent derivation — nothing in the Auror JWT
// identifies a market — so it is manual-only, set from Settings > Defaults.
//
// Sources, in priority order:
//   1. Manual override in chrome.storage.sync["apai.userHomeStoreOverride"]
//      (per-profile, syncs across Edge sign-ins)
//   2. WIN ID parsed from the Auror JWT identity cached at
//      chrome.storage.local["aurorbuddy.fb_aurorIdentity"].aurorUserId
//      (populated by aurorbuddy/lib/firestore.js::captureAurorIdentityFromJwt
//      on first successful AurorBuddy auth)
//
// WIN ID format observed in Auror sub claims: "samlp|wm-us|<wid>.s<NNNNN>"
// where the trailing 3–5 digits are the user's home store number.
// Example: "samlp|wm-us|ses008s.s01458" → store 1458.
//
// Returns null when nothing is available; callers should fall back to a
// "Set your store" UX rather than guessing a default. Works in both
// service-worker and view-page contexts (only uses chrome.storage).

export const OVERRIDE_KEY = "apai.userHomeStoreOverride";
export const MARKET_KEY   = "apai.userHomeMarket";
export const ROLE_KEY     = "apai.userRole";
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


// ── Home market ────────────────────────────────────────────────────────────
//
// Manual-only: the WIN ID encodes a store, not a market, so there is nothing
// to derive this from. VizPick uses it to preselect a market in its rollup
// (modules/vizpick/view.js), falling back to the first market present in the
// captured data when it is unset or not in that capture.
//
// Kept as the string the user typed, deliberately un-normalised: the value is
// compared with === against the Market column of the VizPick export, so
// turning "0120" into "120" here would stop it matching.

export async function getUserHomeMarket() {
  try {
    const got = await chrome.storage.sync.get(MARKET_KEY);
    const v = String(got?.[MARKET_KEY] ?? "").trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function setUserHomeMarket(market) {
  const v = String(market ?? "").trim();
  if (!/^[A-Za-z0-9]{1,8}$/.test(v)) throw new Error("Invalid market");
  await chrome.storage.sync.set({ [MARKET_KEY]: v });
  return v;
}

export async function clearUserHomeMarket() {
  await chrome.storage.sync.remove(MARKET_KEY);
}

/**
 * Subscribe to home-market changes. Returns an unsubscribe function, which
 * callers invoke with no arguments on teardown (see vizpick/view.js cleanup).
 *
 * Fires with the new market string, or null when it is cleared.
 */
export function onUserMarketChange(callback) {
  if (typeof callback !== "function") return () => {};

  const handler = (changes, area) => {
    if (area !== "sync" || !changes?.[MARKET_KEY]) return;
    const raw = changes[MARKET_KEY].newValue;
    const v = String(raw ?? "").trim();
    callback(v || null);
  };

  try {
    chrome.storage.onChanged.addListener(handler);
  } catch {
    return () => {};
  }

  return () => {
    try { chrome.storage.onChanged.removeListener(handler); } catch { /* already gone */ }
  };
}


// ── Role ───────────────────────────────────────────────────────────────────
//
// Declared by the user; nothing in the sign-in identifies it. Modules will
// later be shown or hidden on this basis, so the canonical values live here
// rather than as loose strings at each call site — a module comparing against
// "Hourly" when the shell stored "hourly" would silently gate nothing.
//
// Stored lowercase. Labels are for display only; never persist a label.

export const USER_ROLES = Object.freeze([
  { value: "market", label: "Market",  hint: "Market-level: multiple stores in scope" },
  { value: "salary", label: "Salary",  hint: "Salaried store management" },
  { value: "hourly", label: "Hourly",  hint: "Hourly associate or coach" },
]);

const ROLE_VALUES = USER_ROLES.map((r) => r.value);

export function isValidRole(role) {
  return ROLE_VALUES.includes(String(role ?? "").trim().toLowerCase());
}

export async function getUserRole() {
  try {
    const got = await chrome.storage.sync.get(ROLE_KEY);
    const v = String(got?.[ROLE_KEY] ?? "").trim().toLowerCase();
    return isValidRole(v) ? v : null;
  } catch {
    return null;
  }
}

export async function setUserRole(role) {
  const v = String(role ?? "").trim().toLowerCase();
  if (!isValidRole(v)) throw new Error("Invalid role");
  await chrome.storage.sync.set({ [ROLE_KEY]: v });
  return v;
}

export async function clearUserRole() {
  await chrome.storage.sync.remove(ROLE_KEY);
}

/**
 * Subscribe to role changes. Returns an unsubscribe function, matching the
 * shape of onUserMarketChange. Fires with the new role, or null when cleared.
 *
 * Role gating is not implemented yet; this exists so that when it is, the
 * sidebar can react to a role change without a reload.
 */
export function onUserRoleChange(callback) {
  if (typeof callback !== "function") return () => {};

  const handler = (changes, area) => {
    if (area !== "sync" || !changes?.[ROLE_KEY]) return;
    const v = String(changes[ROLE_KEY].newValue ?? "").trim().toLowerCase();
    callback(isValidRole(v) ? v : null);
  };

  try {
    chrome.storage.onChanged.addListener(handler);
  } catch {
    return () => {};
  }

  return () => {
    try { chrome.storage.onChanged.removeListener(handler); } catch { /* already gone */ }
  };
}


// ── Role-based visibility policy ───────────────────────────────────────────
//
// Kept here, not in app.js, for two reasons: it is pure (so it can be tested
// without a DOM or a chrome stub), and the module-level gating still to come
// will extend this same table rather than scattering role checks through the
// shell.

/**
 * The home-page dashboard strip (livedashboard, ui.kind "home-header") is one
 * store's daily operational picture. A market-level user works across stores,
 * so it is meaningless to them — hidden rather than shown empty, because an
 * empty strip reads as a failed capture rather than as "not for you".
 *
 * An unset role hides nothing: a slow storage read must never blank the UI.
 */
export function isHomeHeaderAllowedForRole(role) {
  return String(role ?? "").trim().toLowerCase() !== "market";
}
