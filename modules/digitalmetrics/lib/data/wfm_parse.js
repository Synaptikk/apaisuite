// modules/digitalmetrics/lib/data/wfm_parse.js
//
// Turn the Workforce Planning scheduler's React state into the schedule
// documents this module stores. Pure — the caller does the page extraction.
//
// ── Where this shape came from ─────────────────────────────────────────────
// Discovered live 2026-08-25 (dev/probe-wfm-worker.mjs). The scheduler holds
// its data on a component prop:
//
//   workers[i] = { worker: {...roster...}, weekTotal, weekEvents: [ Day[7] ] }
//   Day        = { type, shift, startDateTime, endDateTime, ... }
//   Day.shift  = { shiftId, jobId, jobName,
//                  shiftStartDateTime, shiftEndDateTime, breaks[], ... }
//
// `weekEvents[0]` is a SEVEN-element array, Saturday first — the same week
// convention this module already uses (see weeks.js::weekKey), so day index
// maps to date by simple addition from weekStart.
//
// ── Why the donor's scraper is not ported ──────────────────────────────────
// The donor (Downloads\DMtool, "Digital Metrics Data Scraper" v4.6.2) walks
// the fiber tree accepting the first "array of >=5 people-shaped objects" it
// meets. On this page that is `workers` — but it reads the ROSTER half and
// never reaches weekEvents, so it returns N associates and ZERO shifts. Its
// own [4AM DEBUG] output says so. Reproduced 2026-08-25: 351 associates,
// 0 shifts. Everything downstream of it was therefore dead code.
//
// This reads the documented path instead, and fails loudly rather than
// returning an empty-but-successful result.

import { TIME_SLOTS } from "./grid.js";

/** Saturday-first, matching weekEvents[0] index order and DAY_NAMES usage. */
export const DAY_INDEX_ORDER = ["SAT", "SUN", "MON", "TUE", "WED", "THU", "FRI"];

/**
 * Add `days` to a YYYY-MM-DD string, staying in local time.
 *
 * Deliberately not `new Date(iso)` + setDate: parsing a bare YYYY-MM-DD gives
 * UTC midnight, which in any negative-offset timezone is the PREVIOUS day
 * locally — the same trap weeks.js documents.
 */
export function addDays(isoDate, days) {
  const [y, m, d] = String(isoDate).split("-").map((n) => parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(y, m - 1, d + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * "2026-08-22T13:30:00" | "1:30 pm" | Luxon-ish {c:{hour,minute}} → minutes
 * since local midnight, or null.
 *
 * The page carries times three ways: ISO strings on `shift.shiftStartDateTime`,
 * Luxon objects on the day wrapper, and rendered text like "9:00am – 5:00pm".
 * The extractor normalises to ISO where it can, but a fallback for each keeps
 * one changed field from emptying a whole week.
 */
export function toMinutes(value) {
  if (value == null) return null;

  if (typeof value === "object") {
    const c = value.c || value;
    if (Number.isFinite(c.hour)) return c.hour * 60 + (Number.isFinite(c.minute) ? c.minute : 0);
    return null;
  }

  const s = String(value).trim();

  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) return parseInt(iso[1], 10) * 60 + parseInt(iso[2], 10);

  const ampm = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const p = ampm[3].toLowerCase();
    if (p === "pm" && h < 12) h += 12;
    if (p === "am" && h === 12) h = 0;
    return h * 60 + min;
  }

  const bare = s.match(/^(\d{1,2}):(\d{2})$/);
  if (bare) return parseInt(bare[1], 10) * 60 + parseInt(bare[2], 10);

  return null;
}

/** Minutes since midnight → "6:00am" / "1:30pm", the grid's display form. */
export function formatTime(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const period = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * Minutes since midnight → grid slot index.
 *
 * TIME_SLOTS[0] is "5-6", so slot = hour - 5.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ The grid starts at 5am and the store does not. Overnight and early   │
 * │ shifts (10:00pm–7:00am, 4:00am starts — both real on this roster)    │
 * │ have no honest slot.                                                 │
 * │                                                                      │
 * │ The donor clamped with Math.max(0, h - 5), which silently files a    │
 * │ 4am start in the same cell as a 5am one. That is the bug all of its  │
 * │ [4AM DEBUG] instrumentation was chasing and never fixed.             │
 * │                                                                      │
 * │ Here the clamp still happens — the grid has nowhere else to draw —   │
 * │ but it is REPORTED (`clamped`) and the true times are preserved      │
 * │ verbatim in shiftStart/shiftEnd, so the cell can show "4:00am" even  │
 * │ though it sits in the 5-6 column.                                    │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function toSlot(minutes) {
  if (!Number.isFinite(minutes)) return { slot: null, clamped: false };
  const raw = Math.floor(minutes / 60) - 5;
  if (raw < 0) return { slot: 0, clamped: true };
  if (raw > TIME_SLOTS.length) return { slot: TIME_SLOTS.length, clamped: true };
  return { slot: raw, clamped: false };
}

/**
 * Build the schedule payload from extracted worker rows.
 *
 * Input (produced in-page, already plain and serialisable):
 *   { store, weekStart, workers: [ { name, jobName, days: [
 *       { index, type, start, end, jobName } ] } ] }
 *
 * Output matches what schedule_import.js::parseSchedulePayload validates, so
 * the automated path and the paste path converge on one shape and one
 * persistence handler.
 */
export function buildSchedules(extract) {
  const warnings = [];
  const store = extract?.store ? String(extract.store) : null;
  const weekStart = extract?.weekStart || null;

  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return { ok: false, reason: `weekStart missing or not YYYY-MM-DD (got ${JSON.stringify(weekStart)})` };
  }
  const workers = Array.isArray(extract?.workers) ? extract.workers : null;
  if (!workers || !workers.length) {
    return { ok: false, reason: "no workers in the extraction" };
  }

  const schedules = {};
  let shiftCount = 0;
  let clampedCount = 0;
  let skippedNoName = 0;
  let skippedNoTime = 0;

  for (const w of workers) {
    const name = String(w?.name || "").trim();
    if (!name) { skippedNoName++; continue; }

    for (const day of w?.days || []) {
      const idx = Number(day?.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 6) continue;

      const startMin = toMinutes(day?.start);
      const endMin   = toMinutes(day?.end);
      // A day with no shift is normal (Available / Unavailable / Time Off /
      // LOA / Not Scheduled), not an error — only count it when a day claimed
      // to have a shift but no usable time came with it.
      if (startMin == null || endMin == null) {
        if (day?.type === "shift" || day?.shift) skippedNoTime++;
        continue;
      }

      const date = addDays(weekStart, idx);
      if (!date) continue;

      const s = toSlot(startMin);
      const e = toSlot(endMin);
      if (s.clamped || e.clamped) clampedCount++;

      (schedules[date] ||= { associates: [] }).associates.push({
        name: name.toUpperCase(),
        shiftStart: formatTime(startMin),
        shiftEnd:   formatTime(endMin),
        startSlot:  s.slot,
        endSlot:    e.slot,
        // Carried so classification can be derived from the job title rather
        // than ticked by hand — see data/job_classify.js. It is a role, not a
        // personal identifier, so it is safe to store beside the token.
        jobName:    day?.jobName ?? w?.jobName ?? null,
      });
      shiftCount++;
    }
  }

  if (skippedNoName)  warnings.push(`${skippedNoName} worker rows had no usable name.`);
  if (skippedNoTime)  warnings.push(`${skippedNoTime} shifts had no readable start/end time.`);
  if (clampedCount)   warnings.push(`${clampedCount} shifts start or end outside the 5am–10pm grid and were clamped to its edge; the true times are kept on the entry.`);

  if (!shiftCount) {
    return {
      ok: false,
      // The donor failed exactly here and reported success anyway. Be explicit.
      reason: `found ${workers.length} workers but 0 shifts — the scheduler's weekEvents were empty or unreadable.`,
      warnings,
    };
  }

  return {
    ok: true,
    store,
    weekStart,
    schedules,
    dates: Object.keys(schedules).sort(),
    associateCount: shiftCount,
    clampedCount,
    warnings,
  };
}
