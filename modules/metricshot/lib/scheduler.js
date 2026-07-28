// modules/metricshot/lib/scheduler.js
//
// Pure scheduling logic. Given a metric config and "now", figure out which
// scheduled runs are due (within a catch-up window) and haven't already been
// posted. Deterministic run keys make the same scheduled slot repeatable-safe:
// two ticks in the same minute or a restart followed by another tick both
// produce the same key, so the dedupe map (owned by service.js) rejects the
// duplicate.
//
// Timezone handling: uses IANA zone names via Intl.DateTimeFormat with
// timeZone. "local" resolves to the runtime's local timezone. This avoids
// pulling in a full tz library (would need vendored code) — Intl covers what
// the module needs (day-of-week + HH:MM in a named zone).

import { WEEKDAYS } from "./metrics.js";

// ── Time-in-timezone helpers ──

export function resolveZone(zone) {
  if (!zone || zone === "local") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  return zone;
}

/**
 * Returns { yyyyMMdd: "YYYY-MM-DD", dow: "MON"|..., hh: Number, mm: Number }
 * for the given epoch ms in the given IANA timezone.
 */
export function partsInZone(epochMs, zone) {
  const z = resolveZone(zone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: z,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Intl weekday "short" gives Mon/Tue/... — normalize to WEEKDAYS uppercase.
  const dow = String(map.weekday || "").slice(0, 3).toUpperCase();
  const hh = parseInt(map.hour === "24" ? "00" : map.hour, 10);   // Chrome quirk: sometimes "24" at midnight
  const mm = parseInt(map.minute, 10);
  return {
    yyyyMMdd: `${map.year}-${map.month}-${map.day}`,
    dow,
    hh,
    mm,
  };
}

/**
 * Build the deterministic dedupe key for a scheduled run.
 * Example: "vizpick-score:2026-07-26:14:00"
 */
export function keyFor(metricId, yyyyMMdd, hhmm) {
  return `${metricId}:${yyyyMMdd}:${hhmm}`;
}

// Days between two YYYY-MM-DD strings (b - a). Small positive integers only.
function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const A = Date.UTC(ay, am - 1, ad);
  const B = Date.UTC(by, bm - 1, bd);
  return Math.round((B - A) / 86_400_000);
}

// The scheduled epoch of a run is unknowable to the second in a named
// timezone without a tz table, but we don't need it — the dedupe key encodes
// the local slot, and "is this in the catch-up window?" is answerable via
// a small brute-force: was the local wall-clock at (yyyyMMdd, HH:MM) less
// than windowMs ago? We answer that by walking every minute of the last N
// hours in the target zone and looking for the match. windowMs ≤ 24 h keeps
// this cheap (≤ 1440 iterations, only when a metric actually has a matching
// slot in-window).
function scheduledEpochWithinWindow(zone, yyyyMMdd, hh, mm, nowMs, windowMs) {
  // Fast path: if the slot's calendar day matches the current day-in-zone,
  // compute the offset via Intl and be done.
  const nowParts = partsInZone(nowMs, zone);
  if (nowParts.yyyyMMdd === yyyyMMdd) {
    // Approximate the local epoch by walking backward minute-by-minute from
    // now until partsInZone matches (hh, mm) with the same yyyyMMdd. Bounded
    // by 24h.
    return findLocalEpoch(zone, yyyyMMdd, hh, mm, nowMs, windowMs);
  }
  // Otherwise, only bother if the day is close to now — within (windowMs + 25h).
  const dayDelta = daysBetween(nowParts.yyyyMMdd, yyyyMMdd);
  if (dayDelta > 0) return null;                                           // future — not "due"
  if (Math.abs(dayDelta) > Math.ceil(windowMs / 86_400_000) + 1) return null;
  return findLocalEpoch(zone, yyyyMMdd, hh, mm, nowMs, windowMs);
}

// Search backward from `nowMs` in 60s steps for the epoch whose parts-in-zone
// equal (yyyyMMdd, hh, mm). Returns that epoch, or null if not found within
// windowMs + 6 h of slack.
function findLocalEpoch(zone, yyyyMMdd, hh, mm, nowMs, windowMs) {
  const maxLookbackMs = windowMs + 6 * 60 * 60 * 1000; // slack for DST
  const step = 60_000;
  for (let t = nowMs; t >= nowMs - maxLookbackMs; t -= step) {
    const p = partsInZone(t, zone);
    if (p.yyyyMMdd === yyyyMMdd && p.hh === hh && p.mm === mm) return t;
  }
  return null;
}

/**
 * Return every scheduled run for `metric` whose slot has passed (or is now)
 * and is within `catchUpWindowMs` of `nowMs`. Each entry:
 *   {
 *     runKey:      "<metricId>:YYYY-MM-DD:HH:MM",
 *     scheduledAt: epochMs of that local slot,
 *     scheduledFor: { yyyyMMdd, dow, hhmm },
 *   }
 * Idempotent for the same nowMs — no side effects; caller consults their
 * dedupe map to decide what to actually execute.
 */
export function expandDueRuns(metric, nowMs, catchUpWindowMsOverride) {
  if (!metric?.enabled) return [];
  const zone = resolveZone(metric.timezone);
  const windowMs = Number.isFinite(catchUpWindowMsOverride)
    ? catchUpWindowMsOverride
    : (metric.capture?.catchUpWindowMs ?? 60 * 60 * 1000);

  const out = [];
  const seen = new Set();

  // For each scheduled (day, time), consider both "today" and "yesterday" in
  // the metric's zone — a 60-min catch-up window at 00:05 needs to see a
  // 23:30 slot from the previous day. 24h back reliably lands on the prior
  // calendar day in any zone / DST context.
  const nowParts = partsInZone(nowMs, zone);
  const yesterdayMs = nowMs - 24 * 60 * 60 * 1000;
  const yesterdayParts = partsInZone(yesterdayMs, zone);

  for (const sched of metric.schedules ?? []) {
    if (!sched?.time) continue;
    const [hhStr, mmStr] = String(sched.time).split(":");
    const hh = parseInt(hhStr, 10);
    const mm = parseInt(mmStr, 10);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) continue;

    for (const day of [yesterdayParts, nowParts]) {
      if (!sched.days?.includes(day.dow)) continue;

      const scheduledAt = scheduledEpochWithinWindow(
        zone, day.yyyyMMdd, hh, mm, nowMs, windowMs
      );
      if (scheduledAt == null) continue;
      if (scheduledAt > nowMs) continue;                     // still in the future
      const ageMs = nowMs - scheduledAt;
      // Anything within the window is "due"; anything older than the window
      // is still returned (caller marks it as skipped-stale so it won't post).
      // The upper bound is windowMs + 25h (already applied inside findLocalEpoch).
      const hhmm = `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
      const runKey = keyFor(metric.id, day.yyyyMMdd, hhmm);
      if (seen.has(runKey)) continue;
      seen.add(runKey);
      out.push({
        runKey,
        scheduledAt,
        scheduledFor: { yyyyMMdd: day.yyyyMMdd, dow: day.dow, hhmm },
        ageMs,
        stale: ageMs > windowMs,
      });
    }
  }
  // Sort oldest-first — if there's genuinely a backlog of non-stale runs,
  // run them in chronological order.
  return out.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

/**
 * Human-readable "next scheduled run" for the UI. Walks forward minute-by-
 * minute for up to 8 days looking for the earliest matching slot. Returns
 * { at: epochMs, label: "Mon 10:00" } or null.
 */
export function nextRun(metric, nowMs = Date.now(), lookAheadDays = 8) {
  if (!metric?.enabled || !metric.schedules?.length) return null;
  const zone = resolveZone(metric.timezone);
  const maxMs = nowMs + lookAheadDays * 86_400_000;
  const stepMs = 60_000;
  for (let t = nowMs + stepMs; t < maxMs; t += stepMs) {
    const p = partsInZone(t, zone);
    const hhmm = `${String(p.hh).padStart(2,"0")}:${String(p.mm).padStart(2,"0")}`;
    for (const s of metric.schedules) {
      if (!s.days?.includes(p.dow)) continue;
      if (s.time !== hhmm) continue;
      return { at: t, label: `${p.dow} ${hhmm}` };
    }
  }
  return null;
}

// Sanity export for tests: whether "days" cover exactly the seven WEEKDAYS.
export function isAllWeek(days) {
  const s = new Set(days || []);
  return WEEKDAYS.every((d) => s.has(d)) && s.size === 7;
}

/**
 * True when the given scheduled slot (HH:MM local) is the earliest scheduled
 * time on `dow` for this metric — used to decide whether to attach the
 * "extras" follow-up message. 10:00 is first-of-day when schedule is
 * 10:00/14:00/20:00; 14:00 and 20:00 return false.
 *
 * If a specific `dow` isn't in any schedule (metric disabled for that day),
 * returns false.
 */
export function isFirstOfDay(metric, dow, hhmm) {
  if (!metric?.schedules?.length) return false;
  const todaysTimes = metric.schedules
    .filter((s) => s.days?.includes(dow))
    .map((s) => s.time)
    .filter(Boolean)
    .sort();
  if (!todaysTimes.length) return false;
  return todaysTimes[0] === hhmm;
}
