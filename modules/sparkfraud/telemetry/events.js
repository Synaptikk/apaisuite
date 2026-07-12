// modules/sparkfraud/telemetry/events.js
//
// Telemetry — structured event ring buffer for SparkFraud.
//
// Migrated from donor extension/telemetry/events.js. The ONLY changes are:
//   - STORAGE_KEY: "telemetry" → "sparkfraud.telemetry" (avoid collisions
//     with other modules / standalone donor / future shared/logging.js).
//   - Otherwise verbatim — debounced flush, in-memory queue, sanitize regex.
//
// Phase 4 consolidation may promote this pattern to `shared/logging.js` —
// the suite already has a logging.js stub. Until then this module-local
// telemetry stays self-contained.
//
// MANDATORY redaction rules (per docs/ARCHITECTURE.md data-safety):
//   - NO cookie values, NO header values, NO authToken / authHeader.
//   - NO driver/customer names, emails, phones, addresses.
//   - NO order IDs in payloads (counts + booleans only).
// Defensive sanitize() below strips suspicious key names as belt + suspenders;
// callers must still author payloads carefully.

const RING_SIZE = 500;
const STORAGE_KEY = "sparkfraud.telemetry";
const FLUSH_DEBOUNCE_MS = 250;

const FORBIDDEN_KEY_PATTERNS = /authtoken|authheader|cookie|password|secret|phonenumber|firstname|lastname|email|address|orderid|orderno|driveruuid|driveruserid/i;

export const EVENTS = {
  SEARCH_STARTED:              "search.started",
  SEARCH_DISPATCHER_REQUEST:   "search.dispatcher.request",
  SEARCH_DISPATCHER_COMPLETED: "search.dispatcher.completed",
  SEARCH_DISPATCHER_FAILED:    "search.dispatcher.failed",
  SEARCH_VIABILITY_COMPUTED:   "search.viability.computed",
  SEARCH_OMS_COMPLETED:        "search.oms.completed",
  SEARCH_OMS_FAILED:           "search.oms.failed",
  SEARCH_COMPLETED:            "search.completed",
  LOOKUP_STARTED:              "lookup.started",
  LOOKUP_COMPLETED:            "lookup.completed",
  REPLAY_LOADED:               "replay.loaded",
  CONFIDENCE_ASSIGNED:         "confidence.assigned",
  REDACTION_EXPANDED:          "redaction.expanded",
};

// ── internal queue + flush ─────────────────────────────────────────────
let pendingQueue = [];
let flushTimer = null;
let flushInFlight = null;

async function flushNow() {
  if (!pendingQueue.length) return;
  const batch = pendingQueue.splice(0);
  try {
    const cur = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
    const merged = cur.concat(batch);
    if (merged.length > RING_SIZE) merged.splice(0, merged.length - RING_SIZE);
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  } catch (e) {
    pendingQueue = batch.concat(pendingQueue);
    console.warn("[SparkFraud telemetry] flush failed:", e);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushInFlight = flushNow().finally(() => { flushInFlight = null; });
  }, FLUSH_DEBOUNCE_MS);
}

// ── public API ─────────────────────────────────────────────────────────

export function emit(eventName, payload = {}) {
  try {
    pendingQueue.push({
      event: eventName,
      ts: Date.now(),
      payload: sanitize(payload),
    });
    scheduleFlush();
  } catch (e) {
    console.warn("[SparkFraud telemetry] emit failed:", eventName, e);
  }
}

export async function readTelemetry() {
  if (flushInFlight) {
    try { await flushInFlight; } catch (_) {}
  }
  if (pendingQueue.length) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await flushNow();
  }
  return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
}

export async function clearTelemetry() {
  pendingQueue = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await chrome.storage.local.remove(STORAGE_KEY);
}

// ── redaction ──────────────────────────────────────────────────────────

function sanitize(p) {
  if (!p || typeof p !== "object") return p;
  if (Array.isArray(p)) return p.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (FORBIDDEN_KEY_PATTERNS.test(k)) {
      out[k] = "<redacted>";
      continue;
    }
    if (v && typeof v === "object") {
      out[k] = sanitize(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
