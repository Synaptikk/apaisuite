// modules/livedashboard/lib/freshness.js
//
// Per-source freshness state. Stored at chrome.storage.local under keys
// of the form livedashboard.freshness.<sourceId>. The widget reads these
// to show "last refreshed Xm ago", "stale", and "error" states.

const KEY_PREFIX = "livedashboard.freshness.";

const STALE_DEFAULT_MS = {
  absences:     30 * 60 * 1000,
  compliance:   12 * 60 * 60 * 1000,
  accident:     60 * 60 * 1000,
  cvp:          30 * 60 * 1000,
  register:     24 * 60 * 60 * 1000,
};

export async function read(sourceId) {
  const k = KEY_PREFIX + sourceId;
  const got = await chrome.storage.local.get(k);
  const f = got[k] || null;
  if (!f) return null;
  const staleAfterMs = f.staleAfterMs ?? STALE_DEFAULT_MS[sourceId] ?? 60 * 60 * 1000;
  const isStale = f.lastSuccess
    ? (Date.now() - new Date(f.lastSuccess).getTime() > staleAfterMs)
    : true;
  return { ...f, sourceId, staleAfterMs, isStale };
}

export async function readAll(sourceIds = ["absences","compliance","accident","cvp","register"]) {
  const out = {};
  for (const id of sourceIds) out[id] = await read(id);
  return out;
}

export async function startAttempt(sourceId) {
  const k = KEY_PREFIX + sourceId;
  const got = await chrome.storage.local.get(k);
  const prev = got[k] || {};
  await chrome.storage.local.set({
    [k]: {
      ...prev,
      sourceId,
      lastAttempt:   new Date().toISOString(),
      inFlight:      true,
      staleAfterMs:  prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

export async function markSuccess(sourceId) {
  const k = KEY_PREFIX + sourceId;
  const got = await chrome.storage.local.get(k);
  const prev = got[k] || {};
  const now = new Date().toISOString();
  await chrome.storage.local.set({
    [k]: {
      ...prev,
      sourceId,
      lastSuccess:   now,
      lastAttempt:   now,
      lastError:     null,
      inFlight:      false,
      staleAfterMs:  prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

export async function markError(sourceId, errorMessage) {
  const k = KEY_PREFIX + sourceId;
  const got = await chrome.storage.local.get(k);
  const prev = got[k] || {};
  await chrome.storage.local.set({
    [k]: {
      ...prev,
      sourceId,
      lastAttempt:   new Date().toISOString(),
      lastError:     redact(String(errorMessage ?? "unknown")),
      inFlight:      false,
      staleAfterMs:  prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

// Defensive — never let a stack trace / response body containing a token
// leak into the freshness store. See docs/live_dashboard_backend/SECURITY_NOTES.md.
function redact(s) {
  return String(s)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt redacted]")
    .slice(0, 500);
}
