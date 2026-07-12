// shared/logging.js
//
// Structured event ring buffer with debounced flush and PII sanitization.
// Adopted from SparkFraud's telemetry/events.js (the cleanest implementation
// across the three donors) and elevated to a suite-wide platform.
//
// Storage:  chrome.storage.local["shell.telemetry"] — 500-entry ring.
//           This is the ONLY place outside shared/storage.js that should
//           touch chrome.storage.* directly. The "shell.*" namespace is
//           reserved for suite-level infrastructure; modules must always go
//           through host.storage (which forces a "<moduleId>.*" prefix).
// Emit:     SYNCHRONOUS append to in-memory queue + debounced flush
// Read:     readTelemetry() awaits any in-flight flush before reading
// Safety:   sanitize() strips values for keys matching FORBIDDEN_KEY_PATTERNS
//           (authtoken, authheader, cookie, password, secret, phone, name,
//            email, address, orderid, driveruuid, etc.). Modules can extend
//            the pattern via extendForbiddenKeys() at register time.

const RING_SIZE = 500;
const STORAGE_KEY = "shell.telemetry";
const FLUSH_DEBOUNCE_MS = 250;

let forbiddenPattern = /authtoken|authheader|cookie|password|secret|phonenumber|firstname|lastname|email|address|orderid|orderno|driveruuid|driveruserid|jwt|bearer/i;

export function extendForbiddenKeys(re) {
  // Compose: anything matching the new pattern OR the existing one.
  const cur = forbiddenPattern.source;
  forbiddenPattern = new RegExp(`(?:${cur})|(?:${re.source})`, "i");
}

// ── internal queue + flush ─────────────────────────────────────
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
    console.warn("[APAISuite logging] flush failed:", e);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushInFlight = flushNow().finally(() => { flushInFlight = null; });
  }, FLUSH_DEBOUNCE_MS);
}

// ── module-scoped emitter factory ──────────────────────────────
export function createLogging(moduleId) {
  return {
    emit(event, payload = {}) {
      try {
        pendingQueue.push({
          module:  moduleId,
          event,
          ts:      Date.now(),
          payload: sanitize(payload),
        });
        scheduleFlush();
      } catch (e) {
        console.warn(`[APAISuite logging] emit failed: ${moduleId}.${event}`, e);
      }
    },

    async read({ limit = 100 } = {}) {
      if (flushInFlight) { try { await flushInFlight; } catch (_) {} }
      if (pendingQueue.length) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        await flushNow();
      }
      const all = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
      const mine = all.filter((e) => e.module === moduleId);
      return mine.slice(-limit);
    },

    extendForbiddenKeys,
  };
}

export async function readAllTelemetry({ limit = 500 } = {}) {
  if (flushInFlight) { try { await flushInFlight; } catch (_) {} }
  if (pendingQueue.length) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await flushNow();
  }
  const all = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
  return all.slice(-limit);
}

export async function clearTelemetry() {
  pendingQueue = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await chrome.storage.local.remove(STORAGE_KEY);
}

// ── redaction ──────────────────────────────────────────────────
function sanitize(p) {
  if (!p || typeof p !== "object") return p;
  if (Array.isArray(p)) return p.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (forbiddenPattern.test(k)) {
      out[k] = "<redacted>";
      continue;
    }
    out[k] = v && typeof v === "object" ? sanitize(v) : v;
  }
  return out;
}
