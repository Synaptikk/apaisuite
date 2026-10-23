// modules/doorcatch/lib/access.js
//
// The store's Door Catches keys in this browser, and the AP-team unlock that
// fetches them. Shared with lib/store_sync.js, which puts BoB and Lisa and
// Register L/S records behind the same review key.
//
// Access: a browser with no review key asks QRCallBox for one with the name
// the suite read from the user's Walmart session. It is granted when that
// name is on the store's AP team, which any keyed suite refreshes from the
// last 14 days of WFM schedule job titles (Digital Metrics' import) at most
// every 12 h. A key granted that way is re-checked daily and dropped once the
// person is off the AP team; a pasted key is never re-checked.

import { getUserHomeStore } from "../../../shared/userStore.js";
import { getIdentity } from "../../../shared/identity.js";
import { checkIdentity } from "../../../shared/identity_probe.js";
import { requestAccess } from "./api.js";

export const KEY = "doorcatch.settings";
const RECHECK_MS = 24 * 3600_000;

export async function settings() {
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
export async function apAccess(s) {
  // The name is otherwise only learned as a side effect of other modules, so
  // look for it now rather than sending none.
  let me = await getIdentity();
  let check = null;
  if (!me.displayName) { check = await checkIdentity(); me = await getIdentity(); }
  const res = await requestAccess({ storeNbr: s.storeNbr, name: me.displayName || "", win: me.win || "" });
  if (res.ok) {
    const next = { storeNbr: s.storeNbr, reviewKey: res.reviewKey, submitKey: res.submitKey || "", via: "ap", accessAt: Date.now(), match: res.match || null };
    await chrome.storage.local.set({ [KEY]: next });
    return { s: next };
  }
  if (res.status === 403 || res.status === 404) {
    if (s.via === "ap") await chrome.storage.local.set({ [KEY]: { storeNbr: s.storeNbr } });
    const error = me.displayName ? res.error
      : "The suite couldn't find your name. Sign in to gscope or Auror in this browser, then press Check again.";
    return { error: { ok: false, noAccess: true, error, name: me.displayName || "", check: check?.sources || null } };
  }
  return s.reviewKey ? { s } : { error: res };
}

export async function ready() {
  const s = await settings();
  if (!s.storeNbr) return { error: { ok: false, error: "Set the store first." } };
  if (!s.reviewKey || (s.via === "ap" && Date.now() - s.accessAt > RECHECK_MS)) return apAccess(s);
  return { s };
}
