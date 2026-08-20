// modules/sparkscango/lib/freshness.js
//
// Per-source freshness state for Spark & Scan&Go. Copied structure from
// modules/livedashboard/lib/freshness.js — same public API, module-scoped
// key prefix so entries don't collide.

const KEY_PREFIX = "sparkscango.freshness.";

const STALE_DEFAULT_MS = {
  scango_exceptions: 15 * 60 * 1000,
  spark_exceptions:  15 * 60 * 1000,
  scango_audits:     60 * 60 * 1000,
  spark_audits:      60 * 60 * 1000,
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

export async function readAll(sourceIds = Object.keys(STALE_DEFAULT_MS)) {
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

export async function markError(sourceId, errorClass, errorMessage) {
  const k = KEY_PREFIX + sourceId;
  const got = await chrome.storage.local.get(k);
  const prev = got[k] || {};
  await chrome.storage.local.set({
    [k]: {
      ...prev,
      sourceId,
      lastAttempt:   new Date().toISOString(),
      lastError:     redact(String(errorMessage ?? "unknown")),
      lastErrorClass: String(errorClass ?? "UNKNOWN"),
      inFlight:      false,
      staleAfterMs:  prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

// Never let a token or PII leak into the freshness store.
function redact(s) {
  return String(s)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt redacted]")
    .slice(0, 500);
}
