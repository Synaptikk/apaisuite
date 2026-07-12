// shared/userStore.js
//
// Single-source-of-truth for the user's home store number, derived from
// their Walmart WIN ID when available. Replaces the hardcoded "1458"
// defaults that were scattered through the suite.
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
