// shared/debug_feed.js
//
// Live feed of what the extension is doing in the background, for the hidden
// debug panel in Settings.
//
// WHY TWO SOURCES
// ---------------
// Neither one alone shows the whole picture:
//
//   1. chrome.runtime.onMessage — every module broadcast (capture_phase,
//      today_progress, source_complete, …). Genuinely live and needs no
//      instrumentation, because modules already broadcast these for their own
//      views. But an extension page only receives them while it is OPEN, so
//      this source has no history.
//
//   2. chrome.storage.onChanged on shell.telemetry — the ring that
//      shared/logging.js flushes to. This DOES capture service-worker work
//      that happened before the panel was opened, and it keeps arriving while
//      the panel is open because the SW flushes on its own schedule. Its cost
//      is a ~250ms debounce, so it lags the broadcasts slightly.
//
// Merged and de-duplicated, they give "what is happening now" plus "what
// happened while I wasn't looking".
//
// The feed is READ-ONLY. It never sends a message, never triggers a capture,
// and never writes to the telemetry ring — a debug view that perturbs what it
// is measuring is worse than no debug view.
//
// PII: entries from the telemetry ring are already sanitized by
// shared/logging.js::sanitize(). Broadcast payloads are NOT, so they are run
// through the same forbidden-key check here before display — a debug panel is
// exactly where a token would otherwise get shoulder-surfed or pasted into a
// bug report.

const TELEMETRY_KEY = "shell.telemetry";
const UNLOCK_KEY    = "shell.debug.unlocked";

/** How many entries the panel keeps in memory. Display only — not persisted. */
export const FEED_MAX = 400;

/** Taps needed on the Settings heading to reveal the panel. */
export const UNLOCK_TAPS = 10;
/** Start telling the user something is happening at this many taps. */
export const UNLOCK_HINT_AT = 4;

// Mirrors shared/logging.js. Kept as its own copy rather than imported because
// that module's pattern is mutable at runtime via extendForbiddenKeys() and a
// module narrowing it must not be able to widen what this panel will print.
const FORBIDDEN = /authtoken|authheader|cookie|password|secret|phonenumber|firstname|lastname|email|address|orderid|orderno|driveruuid|driveruserid|jwt|bearer|apikey|token/i;

export function redact(value, depth = 0) {
  if (value == null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = FORBIDDEN.test(k) ? "<redacted>" : (v && typeof v === "object" ? redact(v, depth + 1) : v);
  }
  return out;
}

export async function isDebugUnlocked() {
  try {
    const got = await chrome.storage.local.get(UNLOCK_KEY);
    return got?.[UNLOCK_KEY] === true;
  } catch { return false; }
}

export async function setDebugUnlocked(on) {
  try { await chrome.storage.local.set({ [UNLOCK_KEY]: !!on }); } catch {}
}

/**
 * Stable-ish identity for an event, so the same thing arriving down both
 * pipes is shown once. Two genuinely distinct events in the same millisecond
 * with identical module/name/payload are indistinguishable and collapse — an
 * acceptable trade for not double-printing every SW broadcast.
 */
function keyOf(e) {
  return `${e.ts}|${e.module}|${e.event}|${e.detailKey}`;
}

function normaliseTelemetry(row) {
  const detail = redact(row.payload ?? {});
  return {
    ts: row.ts ?? Date.now(),
    source: "sw",
    module: row.module || "shell",
    event: row.event || "(unnamed)",
    detail,
    detailKey: safeKey(detail),
  };
}

function normaliseMessage(msg) {
  const { module, type, ...rest } = msg || {};
  const detail = redact(rest);
  return {
    ts: Date.now(),
    source: "msg",
    module: module || "shell",
    event: type || "(unnamed)",
    detail,
    detailKey: safeKey(detail),
  };
}

function safeKey(d) {
  try { return JSON.stringify(d).slice(0, 200); } catch { return "?"; }
}

/**
 * Start the feed.
 *
 * @param {object} opts
 * @param {(events:object[]) => void} opts.onEvents  Called with NEW events,
 *   oldest-first, whenever any arrive.
 * @param {number} [opts.backfill]  How many historical ring entries to load.
 * @returns {Promise<{stop:()=>void, isPaused:()=>boolean, setPaused:(b:boolean)=>void}>}
 */
export async function startDebugFeed({ onEvents, backfill = 120 } = {}) {
  const seen = new Set();
  let paused = false;

  const push = (events) => {
    const fresh = [];
    for (const e of events) {
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(e);
    }
    // Bound the dedupe set so a long-lived panel cannot grow without limit.
    if (seen.size > FEED_MAX * 4) {
      const keep = [...seen].slice(-FEED_MAX * 2);
      seen.clear();
      for (const k of keep) seen.add(k);
    }
    if (fresh.length && !paused) onEvents(fresh.sort((a, b) => a.ts - b.ts));
  };

  // 1. Backfill from the telemetry ring so the panel is not blank on open.
  try {
    const got = await chrome.storage.local.get(TELEMETRY_KEY);
    const ring = got?.[TELEMETRY_KEY] || [];
    push(ring.slice(-backfill).map(normaliseTelemetry));
  } catch { /* best effort */ }

  // 2. Live broadcasts.
  const onMessage = (msg) => {
    // Only module broadcasts have this shape; ignore request/response traffic
    // aimed at a handler, which carries no `type` we would want to print.
    if (!msg || typeof msg !== "object" || !msg.type) return;
    push([normaliseMessage(msg)]);
    // Never return true: doing so would claim the message and break the
    // sender's real reply path.
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // 3. Service-worker telemetry as it flushes.
  const onChanged = (changes, area) => {
    if (area !== "local" || !changes[TELEMETRY_KEY]) return;
    const next = changes[TELEMETRY_KEY].newValue || [];
    push(next.slice(-60).map(normaliseTelemetry));
  };
  chrome.storage.onChanged.addListener(onChanged);

  return {
    stop() {
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
      try { chrome.storage.onChanged.removeListener(onChanged); } catch {}
    },
    isPaused: () => paused,
    setPaused: (b) => { paused = !!b; },
  };
}

/** Scheduled background work, so "nothing is happening" can be told apart
 *  from "nothing is scheduled" — the exact failure the 2026-08-20 alarm sweep
 *  was invisible for. */
export async function readAlarms() {
  try {
    const alarms = await chrome.alarms.getAll();
    return alarms
      .map((a) => ({
        name: a.name,
        periodInMinutes: a.periodInMinutes ?? null,
        scheduledTime: a.scheduledTime,
        inMs: a.scheduledTime - Date.now(),
      }))
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  } catch {
    return [];
  }
}
