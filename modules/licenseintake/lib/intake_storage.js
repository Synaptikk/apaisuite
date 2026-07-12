// modules/licenseintake/lib/intake_storage.js
//
// Local storage for IntakeSession records, namespaced via shared/storage.js
// so keys land at `local:licenseintake.sessions` etc.
//
// PII rules applied here:
//   - We do NOT persist the raw barcode payload. Only the parsed
//     LicensePerson + downstream review state. parsedPerson IS PII;
//     it's persisted because the workflow requires resuming reviews,
//     but the storage area is local-disk (BitLocker-protected on this
//     managed device) and never network-synced.
//   - chrome.storage.sync is NEVER used for session data.
//   - Storage operations log only counts + sessionIds (opaque), never
//     field values.

import { createStorage } from "../../../shared/storage.js";
import { touch } from "./intake_models.js";

const MODULE_ID = "licenseintake";
const SESSIONS_KEY = "sessions";
const SETTINGS_KEY = "settings";
const SESSION_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

const _store = createStorage(MODULE_ID);

// Default operator-visible settings. Dry-run is on by default so the
// overnight build can't accidentally hit live Auror/APPRISS.
const DEFAULT_SETTINGS = Object.freeze({
  dryRun: true,
  autoSearchOnParse: false,
  defaultHomeStore: null,
});

/**
 * @typedef {import("./intake_models.js").IntakeSession} IntakeSession
 */

/**
 * Delete sessions whose lastUpdated is older than SESSION_TTL_MS.
 * Called automatically by listSessions(). Logs only the count.
 */
async function purgeExpiredSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const all = (await _store.local.get(SESSIONS_KEY)) || {};
  const expired = Object.keys(all).filter(id => (all[id].lastUpdated || 0) < cutoff);
  if (!expired.length) return;
  for (const id of expired) delete all[id];
  await _store.local.set(SESSIONS_KEY, all);
  console.info(`[licenseintake/storage] purged ${expired.length} session(s) older than 72h`);
}

/**
 * Read all stored sessions, newest first.
 * @returns {Promise<IntakeSession[]>}
 */
export async function listSessions() {
  await purgeExpiredSessions();
  const all = (await _store.local.get(SESSIONS_KEY)) || {};
  const arr = Object.values(all);
  return arr.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
}

/**
 * Get a single session by id.
 * @param {string} sessionId
 */
export async function getSession(sessionId) {
  const all = (await _store.local.get(SESSIONS_KEY)) || {};
  return all[sessionId] || null;
}

/**
 * Upsert. The session is keyed by sessionId.
 * @param {IntakeSession} session
 */
export async function saveSession(session) {
  if (!session?.sessionId) throw new Error("saveSession: sessionId required");
  touch(session);
  const all = (await _store.local.get(SESSIONS_KEY)) || {};
  all[session.sessionId] = session;
  await _store.local.set(SESSIONS_KEY, all);
  console.info(`[licenseintake/storage] saved session ${session.sessionId} (status=${session.reviewStatus})`);
  return session;
}

/**
 * Delete a session by id. Removes ALL associated data; no soft-delete.
 * @param {string} sessionId
 */
export async function deleteSession(sessionId) {
  const all = (await _store.local.get(SESSIONS_KEY)) || {};
  if (!all[sessionId]) return false;
  delete all[sessionId];
  await _store.local.set(SESSIONS_KEY, all);
  console.info(`[licenseintake/storage] deleted session ${sessionId}`);
  return true;
}

/**
 * Wipe ALL sessions. Used by the "Clear all session data" button. Logs
 * only the count, never the contents.
 */
export async function clearAllSessions() {
  const all = (await _store.local.get(SESSIONS_KEY)) || {};
  const n = Object.keys(all).length;
  await _store.local.remove(SESSIONS_KEY);
  console.info(`[licenseintake/storage] cleared ${n} sessions`);
  return n;
}

/**
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function loadSettings() {
  const s = await _store.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 */
export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await _store.local.set(SETTINGS_KEY, next);
  console.info(`[licenseintake/storage] settings updated: dryRun=${next.dryRun}`);
  return next;
}

/**
 * Live-update hook (UI uses this to re-render on multi-tab edits).
 * @param {(changes: Record<string, chrome.storage.StorageChange>) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onChange(handler) {
  return _store.local.onChange(handler);
}

/**
 * Resolve the operator's home store, with fallbacks. Order:
 *   1. licenseintake.settings.defaultHomeStore (if operator set it here)
 *   2. livedashboard.settings.storeNbr (sync)
 *   3. closinglist.storeNbr (sync)
 *   4. Auror account page — extract store from the user's Walmart email.
 *      Walmart emails follow the pattern "xxx.s0XXXX.yyy@wal-mart.com"
 *      where XXXX is the store number.
 *
 * On a successful sibling-module or Auror read the value is persisted into
 * our own settings so subsequent lookups are local + fast.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveHomeStore() {
  // 1. Our own setting wins if set.
  const ours = await loadSettings();
  if (ours.defaultHomeStore) return String(ours.defaultHomeStore);

  // 2. Try livedashboard (uses chrome.storage.sync; key is
  //    `livedashboard.settings` with shape { storeNbr, ... }).
  try {
    const got = await chrome.storage.sync.get("livedashboard.settings");
    const livedashStore = got?.["livedashboard.settings"]?.storeNbr;
    if (livedashStore) {
      console.info(`[licenseintake/storage] auto-detected homeStore=${livedashStore} from livedashboard`);
      await saveSettings({ defaultHomeStore: String(livedashStore) });
      return String(livedashStore);
    }
  } catch { /* ignore */ }

  // 3. Try closinglist (uses createStorage namespace; key
  //    `closinglist.storeNbr`).
  try {
    const got = await chrome.storage.sync.get("closinglist.storeNbr");
    const clStore = got?.["closinglist.storeNbr"];
    if (clStore) {
      console.info(`[licenseintake/storage] auto-detected homeStore=${clStore} from closinglist`);
      await saveSettings({ defaultHomeStore: String(clStore) });
      return String(clStore);
    }
  } catch { /* ignore */ }

  // 4. Read the operator's Walmart email from any open Auror tab.
  //    The email local-part contains ".s0XXXX." where XXXX is the store number.
  //    Example: "ses008s.s01458.us@wal-mart.com" → store 1458.
  try {
    const aurorTabs = await chrome.tabs.query({ url: "https://app.us.auror.co/*" });
    const tab = aurorTabs[0];
    if (tab?.id) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Next.js server props (most reliable)
          try {
            const nd = window.__NEXT_DATA__;
            const e = nd?.props?.pageProps?.viewer?.email
              || nd?.props?.pageProps?.currentUser?.email;
            if (e) return e;
          } catch { /* ignore */ }
          // localStorage — try common keys used by auth/session libraries
          try {
            for (const key of Object.keys(localStorage)) {
              const raw = localStorage.getItem(key);
              if (!raw || !raw.includes("wal-mart.com")) continue;
              try {
                const val = JSON.parse(raw);
                const email = val?.email || val?.user?.email
                  || val?.viewer?.email || val?.currentUser?.email;
                if (email && email.includes("@wal-mart.com")) return email;
              } catch { /* not JSON — try raw match */ }
              const m = raw.match(/[\w.+-]+@wal-mart\.com/);
              if (m) return m[0];
            }
          } catch { /* ignore */ }
          // Last resort: scan visible text for the email pattern
          const m = (document.body.innerText || "").match(/[\w.+-]+@wal-mart\.com/);
          return m ? m[0] : null;
        },
      });
      const email = results?.[0]?.result;
      if (email) {
        // Pattern: ".s0XXXX." in the local part (the dot before s0 prevents
        // matching "ses0" which also has s0 but is not the store segment)
        const storeM = email.match(/\.s0(\d{3,5})\./i);
        if (storeM) {
          const store = storeM[1];
          console.info(`[licenseintake/storage] auto-detected homeStore=${store} from Auror email (${email})`);
          await saveSettings({ defaultHomeStore: store });
          return store;
        }
      }
    }
  } catch (err) {
    console.warn("[licenseintake/storage] Auror email store detection failed:", err?.message || err);
  }

  return null;
}
