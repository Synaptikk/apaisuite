// modules/market120/lib/freshness.js
//
// Per-source freshness state for market120. Same shape as livedashboard's
// freshness module — copied verbatim with KEY_PREFIX and stale defaults
// changed. Sources: "clearance" (Tableau) and "isa" (Power BI).

const KEY_PREFIX = "market120.freshness.";

const STALE_DEFAULT_MS = {
  // Tableau publishes every 2-3h; consider stale after 4h.
  clearance: 4 * 60 * 60 * 1000,
  // ISA refreshes daily; consider stale after 26h to allow a bit of drift.
  isa: 26 * 60 * 60 * 1000,
  // Store-level snapshots are weekly; consider stale after 8 days so a
  // slightly-late weekly refresh doesn't flip to "stale" prematurely.
  stores: 8 * 24 * 60 * 60 * 1000,
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

export async function readAll(sourceIds = ["clearance", "isa", "stores"]) {
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
      lastUnavailable: null,
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
      lastUnavailable: null,
      inFlight:      false,
      staleAfterMs:  prev.staleAfterMs ?? STALE_DEFAULT_MS[sourceId],
    },
  });
}

// A KNOWN, expected limitation — not a failure. Example: the Tableau
// Clearance/Deleted workbook renders KPIs as server-side PNG tiles, so there
// is nothing machine-readable to parse. This must NOT surface as a red
// "error — see console" (there's nothing in the console, and it alarms execs);
// it renders as a neutral "unavailable" badge with the reason inline.
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
