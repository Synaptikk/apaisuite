// modules/digitalmetrics/lib/data/first_pick.js
//
// True late starts for everyone whose first hour on the board is Pick, not
// just the 5am crew. Pure.
//
// Three times per associate-day (the user, 2026-09-23):
//   scheduled start — the grid row's shift (shiftLabel, else its first slot)
//   clock-in        — the first IN punch in Global Time & Attendance
//   first pick      — "Min. First Scan" from the pick metrics
//
// "Scheduled to pick at 1pm, clocks in at 1:05, first pick at 1:28" reads as
// 5 minutes late to the clock, 23 more to the first pick, 28 minutes lost.

import { parseClock } from "./clock.js";
import { shiftMinutes } from "./grid.js";
import { dateKey, findAssignmentMatch } from "./adherence.js";

const SLOT_START_HOUR = 5;
/** A first scan this long after the scheduled start is not a late start — it is a different job. */
const MAX_LATE_MINUTES = 180;

/** The first in-shift slot of a grid row, or null. */
function firstSlot(row) {
  if (typeof row?.shiftStart === "number") return row.shiftStart;
  const keys = Object.keys(row?.slots || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return keys.length ? keys[0] : null;
}

/** Grid rows (present, first hour = Pick) with their scheduled start in minutes. */
export function firstHourPickers(roster) {
  const out = [];
  for (const row of roster || []) {
    if (!row?.name || row.status === "absent") continue;
    const s = firstSlot(row);
    if (s == null || String(row.slots?.[s] ?? "").toLowerCase() !== "pick") continue;
    const start = shiftMinutes(row)?.startMin ?? (SLOT_START_HOUR + s) * 60;
    out.push({ row, name: row.name, schedStart: start });
  }
  return out;
}

/** Every roster name that needs a clock-in for these days. */
export function clockInCandidates(assignmentsByDate) {
  const names = new Set();
  for (const doc of Object.values(assignmentsByDate || {}))
    for (const p of firstHourPickers(doc?.associates)) names.add(p.name);
  return [...names].sort();
}

/** { iso: { rosterName: firstScanMinutes } } from the pick metrics. */
function firstScans(rawData, assignmentsByDate) {
  const out = {};
  let last = null;
  for (const row of rawData || []) {
    const date = row["Pick Date"] ? dateKey(row["Pick Date"]) : last;
    if (row["Pick Date"]) last = date;
    const c = parseClock(row["Min. First Scan"]);
    const roster = assignmentsByDate?.[date]?.associates;
    if (!c || !row.Associate || !roster) continue;
    const match = findAssignmentMatch(row.Associate, roster);
    if (!match) continue;
    const min = c.hour * 60 + c.minutes;
    const day = (out[date] ||= {});
    day[match.name] = Math.min(day[match.name] ?? Infinity, min);
  }
  return out;
}

/**
 * @param clockIns { iso: { rosterName: { clockIn } } }  (minutes since midnight)
 * @returns { days: [...], people: [...], totals }
 *   day = { date, name, schedStart, clockIn, firstPick, clockLate, clockToPick, lost }
 */
export function firstHourStarts(assignmentsByDate, rawData, clockIns = {}) {
  const scans = firstScans(rawData, assignmentsByDate);
  const days = [];
  for (const [date, doc] of Object.entries(assignmentsByDate || {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const p of firstHourPickers(doc?.associates)) {
      const clockIn = clockIns?.[date]?.[p.name]?.clockIn ?? null;
      let firstPick = scans[date]?.[p.name] ?? null;
      // A first scan hours after the shift started means they picked later in
      // the day after other work — not a late start. Drop it rather than
      // charge three hours to "late".
      if (firstPick != null && firstPick - p.schedStart > MAX_LATE_MINUTES) firstPick = null;
      if (clockIn == null && firstPick == null) continue;
      days.push({
        date, name: p.name, schedStart: p.schedStart, clockIn, firstPick,
        clockLate:   clockIn   != null ? clockIn - p.schedStart : null,
        clockToPick: clockIn != null && firstPick != null ? firstPick - clockIn : null,
        lost:        firstPick != null ? Math.max(0, firstPick - p.schedStart) : null,
      });
    }
  }

  const byName = new Map();
  for (const d of days) {
    const p = byName.get(d.name) || byName.set(d.name, { name: d.name, days: [] }).get(d.name);
    p.days.push(d);
  }
  const avg = (xs) => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
  const people = [...byName.values()].map((p) => {
    const pick = (k) => p.days.map((d) => d[k]).filter((x) => x != null);
    return {
      name: p.name, days: p.days, dayCount: p.days.length,
      avgClockLate: avg(pick("clockLate")), avgClockToPick: avg(pick("clockToPick")),
      totalLost: pick("lost").reduce((s, x) => s + x, 0),
      lateClockDays: pick("clockLate").filter((m) => m > 0).length,
    };
  }).sort((a, b) => b.totalLost - a.totalLost);

  return {
    days, people,
    totals: {
      associates: people.length,
      withClock: days.filter((d) => d.clockIn != null).length,
      lostMinutes: people.reduce((s, p) => s + p.totalLost, 0),
      avgClockToPick: avg(days.map((d) => d.clockToPick).filter((x) => x != null)),
      lateClockDays: people.reduce((s, p) => s + p.lateClockDays, 0),
    },
  };
}

/** 13*60+5 → "1:05 PM" */
export function clockText(min) {
  if (min == null) return "—";
  const h24 = Math.floor(min / 60) % 24, m = min % 60;
  return `${((h24 + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}
