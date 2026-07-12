// shared/updater.js
//
// In-extension "new version available" checker. Runs in the service worker.
//
// Why this exists (and not just rely on Chrome's own auto-update flow):
//   * "Load unpacked" installs DO NOT get Chrome-driven auto-update — Chrome
//     ignores update_url for unpacked extensions, full stop.
//   * Chrome Web Store installs DO auto-update silently, but the poll period
//     is ~5 hours and there's no in-app "what's new" surface.
//
// This module bridges both: it polls a small version.json published at
// https://qrcallbox.com/extension/version.json, compares to the installed
// version, and writes a payload to chrome.storage.local that the shell UI
// reads to show a "v0.X.Y available — download" pill.
//
// Storage:
//   chrome.storage.local["shell.updater.available"]
//     = null                           — no update or check failed
//     | {                                — update available
//         version: "0.5.0",
//         currentVersion: "0.4.0",
//         downloadUrl: "https://qrcallbox.com/extension/",
//         zipUrl:      "https://qrcallbox.com/extension/apaisuite-0.5.0.zip",
//         cwsListingUrl: "https://chrome.google.com/...",   // may be ""
//         releaseNotes: "…",
//         publishedAt: "2026-05-28T18:00:00Z",
//         checkedAt:   1748462400000,
//       }
//
//   chrome.storage.local["shell.updater.lastCheckedAt"] = <ms epoch>
//   chrome.storage.local["shell.updater.lastError"]     = <string|null>
//
// The shell page reads these via createStorage("shell") and subscribes to
// chrome.storage.onChanged to update the indicator reactively.

const VERSION_URL = "https://qrcallbox.com/extension/version.json";
const STORAGE_KEY_AVAILABLE = "shell.updater.available";
const STORAGE_KEY_LAST_AT   = "shell.updater.lastCheckedAt";
const STORAGE_KEY_LAST_ERR  = "shell.updater.lastError";

// Network timeout — version.json is tiny (~300 bytes). If the corp proxy or
// CDN is slow, we'd rather give up and retry next alarm than block the SW.
const FETCH_TIMEOUT_MS = 10_000;

// Compare two "x.y.z" version strings. Returns negative / 0 / positive.
// Treats missing numeric parts as 0 ("1.2" → 1.2.0). Tolerates extra parts.
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      method: "GET",
      cache: "no-cache",
      credentials: "omit",
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Read the version.json published alongside the extension on qrcallbox.com.
// Returns the parsed object on 2xx, or throws.
async function fetchRemoteVersion() {
  const res = await fetchWithTimeout(VERSION_URL, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${VERSION_URL}`);
  const data = await res.json();
  if (!data || typeof data.version !== "string") {
    throw new Error("version.json missing required string field 'version'");
  }
  return data;
}

/**
 * Check for a newer published version. Writes result to chrome.storage.local.
 * Safe to call repeatedly — it self-throttles via storage timestamps inside
 * the SW alarm callback. Returns the new state object (for tests / manual
 * invocations from the SW devtools console).
 */
export async function checkForUpdate() {
  const installed = chrome.runtime.getManifest().version;
  const checkedAt = Date.now();

  let remote;
  try {
    remote = await fetchRemoteVersion();
  } catch (err) {
    const msg = String(err?.message ?? err);
    console.warn("[APAISuite updater] check failed:", msg);
    await chrome.storage.local.set({
      [STORAGE_KEY_LAST_AT]: checkedAt,
      [STORAGE_KEY_LAST_ERR]: msg,
    });
    return { ok: false, error: msg };
  }

  const isNewer = compareVersions(remote.version, installed) > 0;

  if (!isNewer) {
    // Same or older — clear any stale "available" state so the pill hides.
    await chrome.storage.local.set({
      [STORAGE_KEY_AVAILABLE]: null,
      [STORAGE_KEY_LAST_AT]: checkedAt,
      [STORAGE_KEY_LAST_ERR]: null,
    });
    return { ok: true, available: false, installed, remoteVersion: remote.version };
  }

  const payload = {
    version: remote.version,
    currentVersion: installed,
    downloadUrl: remote.downloadUrl || "https://qrcallbox.com/extension/",
    zipUrl: remote.zipUrl || "",
    cwsListingUrl: remote.cwsListingUrl || "",
    releaseNotes: remote.releaseNotes || "",
    publishedAt: remote.publishedAt || "",
    checkedAt,
  };

  await chrome.storage.local.set({
    [STORAGE_KEY_AVAILABLE]: payload,
    [STORAGE_KEY_LAST_AT]: checkedAt,
    [STORAGE_KEY_LAST_ERR]: null,
  });

  console.log(`[APAISuite updater] new version available: ${installed} → ${remote.version}`);
  return { ok: true, available: true, payload };
}

// Exported constants so the SW + UI agree on storage keys without re-typing.
export const UPDATER_STORAGE_KEYS = Object.freeze({
  available: STORAGE_KEY_AVAILABLE,
  lastCheckedAt: STORAGE_KEY_LAST_AT,
  lastError: STORAGE_KEY_LAST_ERR,
});
