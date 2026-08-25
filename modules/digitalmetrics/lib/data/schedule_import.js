// modules/digitalmetrics/lib/data/schedule_import.js
//
// Validates the schedule payload produced by the scraper. Pure.
//
// Shape:
//   { store?: "1458",
//     schedules: { "2026-01-03": { associates: [ { name, shiftStart, shiftEnd,
//                                                  startSlot, endSlot } ] } } }
//
// Validated rather than trusted: the payload arrives through the clipboard, so
// it may be truncated, from another store, or not a schedule at all. A bad
// paste should produce a clear message, not a half-written week in Firestore.

import { TIME_SLOTS } from "./grid.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Clamp a slot index into the grid, or null if it isn't a usable number. */
function slot(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(TIME_SLOTS.length, Math.trunc(n)));
}

export function parseSchedulePayload(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return { ok: false, reason: "That isn't valid JSON — paste the whole export." };
  }

  if (!data || typeof data !== "object") {
    return { ok: false, reason: "Expected a schedule export object." };
  }
  const raw = data.schedules;
  if (!raw || typeof raw !== "object" || !Object.keys(raw).length) {
    return { ok: false, reason: "No schedules found in that payload." };
  }

  const schedules = {};
  const warnings = [];
  let associateCount = 0;

  for (const [date, day] of Object.entries(raw)) {
    if (!ISO_DATE.test(date)) {
      warnings.push(`Skipped "${date}" — not a YYYY-MM-DD date.`);
      continue;
    }

    const list = Array.isArray(day?.associates) ? day.associates : null;
    if (!list) {
      warnings.push(`Skipped ${date} — no associates array.`);
      continue;
    }

    const associates = [];
    for (const a of list) {
      const name = String(a?.name || "").trim().toUpperCase();
      if (!name) continue;   // an unnamed row cannot be matched to anything

      associates.push({
        name,
        shiftStart: a.shiftStart ?? null,
        shiftEnd:   a.shiftEnd   ?? null,
        startSlot:  slot(a.startSlot),
        endSlot:    slot(a.endSlot),
      });
    }

    if (!associates.length) {
      warnings.push(`Skipped ${date} — no usable associates.`);
      continue;
    }

    schedules[date] = { associates };
    associateCount += associates.length;
  }

  if (!Object.keys(schedules).length) {
    return { ok: false, reason: "No usable days in that payload.", warnings };
  }

  return {
    ok: true,
    schedules,
    dates: Object.keys(schedules).sort(),
    associateCount,
    // Carried so the UI can warn when the paste is from a different store.
    store: data.store ? String(data.store) : null,
    warnings,
  };
}
