// modules/vizpick/lib/freshness.js
//
// Per-source freshness state for vizpick. Same shape as market120's
// freshness module — copied verbatim with KEY_PREFIX and stale defaults
// changed. Single source: "stores" (Tableau VizPick crosstab).

const KEY_PREFIX = "vizpick.freshness.";

const STALE_DEFAULT_MS = {
  // The VizPick summary view is "refreshed daily for the day prior" — allow
  // 26h so a slightly late upstream job doesn't read as stale.
  stores: 26 * 60 * 60 * 1000,
  // VizPickDetails is "refreshed frequently for the current business day,
  // 1-2 hours behind" — a Today capture older than 3h is worth re-pulling.
  today: 3 * 60 * 60 * 1000,
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

export async function readAll(sourceIds = ["stores", "today"]) {
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
      lastSuccess:     now,
      lastAttempt:     now,
      lastError:       null,
      lastUnavailable: null,
      inFlight:        false,
      staleAfterMs:    prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
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
      lastAttempt:     new Date().toISOString(),
      lastError:       redact(String(errorMessage ?? "unknown")),
      lastUnavailable: null,
      inFlight:        false,
      staleAfterMs:    prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

export async function markUnavailable(sourceId, reason) {
  const k = KEY_PREFIX + sourceId;
  const got = await chrome.storage.local.get(k);
  const prev = got[k] || {};
  await chrome.storage.local.set({
    [k]: {
      ...prev,
      sourceId,
      lastAttempt:     new Date().toISOString(),
      lastUnavailable: redact(String(reason ?? "unavailable")),
      lastError:       null,
      inFlight:        false,
      staleAfterMs:    prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

// Never let a token or stack trace containing a bearer/JWT leak into
// persistent freshness state.
function redact(s) {
  return String(s)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt redacted]")
    .slice(0, 500);
}
