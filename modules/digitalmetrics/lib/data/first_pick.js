// modules/digitalmetrics/lib/data/first_pick.js
//
// Late starts and early stops for everyone scheduled to pick. Pure.
//
// Per associate-day, from three sources (the user, 2026-09-23 and 2026-09-27):
//   scheduled start/end — the grid row's shift (shiftLabel, else its slots)
//   clock-in / clock-out — the first IN and last OUT punch in Global Time &
//                          Attendance
//   first / last pick   — "Min. First Scan" / "Max. Last Scan" from the
//                          pick metrics
//
// "Scheduled to pick at 1pm, clocks in at 1:05, first pick at 1:28" reads as
// 5 minutes late to the clock — inside the 9-minute grace, so not counted —
// and 23 minutes idle between the clock-in and the first pick. "Scheduled to
// pick 4-5pm, last pick 4:15, clocked out 4:51" reads as 36 minutes on the
// clock after the last pick, and out 9 minutes early, which the grace
// forgives. Each day's TOTAL is the two idle gaps added: on the clock, on a
// pick hour, not picking.
//
// Who counts: any present row with a Pick slot. Clock lateness applies to
// all of them — the shift starts when it starts, whatever the first task.
//
// The idle gaps count only minutes that fall inside the person's scheduled
// PICK HOURS. The start gap is the Pick minutes between the start of
// picking and the first scan; the end gap is the Pick minutes between the
// last scan and the end of picking. "Start of picking" is the clock-in when
// the Pick hours open the shift and the first Pick slot otherwise; "end of
// picking" is the clock-out when they close the shift (time on the clock
// after the last Pick slot counts too) and the last Pick slot otherwise.
//
// Two cases that shaped this (2026-09-27): one associate — DISP until 6pm, Pick
// 6–8pm, first pick 6:05, last 6:30 — is 5 + 90, invisible while the
// shift's ends were measured. Another — Pick 8–10, DISP 10–3, Pick 3–4,
// scans 11:02 and 11:26 — is 120 + 53: her DISP hours are not idle picking
// time, which a first-Pick-slot-to-last-Pick-slot span had charged her.

import { parseClock } from "./clock.js";
import { shiftMinutes } from "./grid.js";
import { dateKey, findAssignmentMatch } from "./adherence.js";

const SLOT_START_HOUR = 5;
/** A punch within this many minutes of the scheduled start/end is on time (the user, 2026-09-27). */
export const CLOCK_GRACE_MIN = 9;
/**
 * A gap between a punch and the nearest pick this long or shorter is a walk
 * to the clock, not idle time; over it the WHOLE gap counts (the user,
 * 2026-09-27: "in at 7, first pick 7:20 → +20; last pick 3:15, out 3:50 →
 * +35; 55 total").
 */
export const PICK_START_GRACE_MIN = 3;
/**
 * A gap longer than this at either end is most likely another role with the
 * board not updated — someone hiding or dragging their feet does it for
 * less (the user, 2026-09-27). Shown, summed as "off board", kept out of
 * the total.
 */
export const MOVED_MIN = 50;
/** A first scan this long after the scheduled start is not a late start — it is a different job. */
const MAX_LATE_MINUTES = 180;

const isPick = (t) => String(t ?? "").toLowerCase() === "pick";
/** Cells that mark time off or a half-hour tail, not a task: skipped when asking what the shift starts and ends with. */
const isBreak = (t) => ["30", "L", "L30", "B"].includes(String(t ?? "").toUpperCase());

/** In-shift slot numbers of a grid row, ascending. */
function slotKeys(row) {
  return Object.keys(row?.slots || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

/** The first in-shift slot of a grid row, or null. */
function firstSlot(row) {
  if (typeof row?.shiftStart === "number") return row.shiftStart;
  const keys = slotKeys(row);
  return keys.length ? keys[0] : null;
}

/**
 * The last planned slot of a grid row, or null: the shift's last slot, or a
 * filled cell beyond it. A schedule ending on the half hour leaves the
 * trailing "30" cell outside shiftEnd, and that cell is where the board
 * plans it; an unfilled tail of the shift is still the shift.
 */
function lastSlot(row) {
  const keys = slotKeys(row);
  const fromShift = typeof row?.shiftEnd === "number" ? row.shiftEnd - 1 : null;
  if (fromShift == null) return keys.length ? keys.at(-1) : null;
  return keys.length ? Math.max(fromShift, keys.at(-1)) : fromShift;
}

/**
 * Present grid rows with at least one Pick slot, with their scheduled start
 * and end in minutes since midnight and which ends of the shift are Pick.
 */
export function scheduledPickers(roster) {
  const out = [];
  for (const row of roster || []) {
    if (!row?.name || row.status === "absent") continue;
    if (!Object.values(row.slots || {}).some(isPick)) continue;
    const first = firstSlot(row), last = lastSlot(row);
    if (first == null || last == null) continue;
    const shift = shiftMinutes(row);
    // Every in-shift slot, breaks and the "30" tail aside — an unfilled slot
    // is still shift time with no picking planned in it.
    const inShift = [];
    for (let k = first; k <= last; k++) if (!isBreak(row.slots?.[k])) inShift.push(k);
    const picks = inShift.filter((k) => isPick(row.slots?.[k]));
    if (!picks.length) continue;
    out.push({
      row, name: row.name,
      schedStart:    shift?.startMin ?? (SLOT_START_HOUR + first) * 60,
      schedEnd:      shift?.endMin   ?? (SLOT_START_HOUR + last + 1) * 60,
      // The pick block: first Pick slot's start to last Pick slot's end, and
      // the Pick hours themselves as merged [start, end) minute ranges.
      pickStart:     (SLOT_START_HOUR + picks[0]) * 60,
      pickEnd:       (SLOT_START_HOUR + picks.at(-1) + 1) * 60,
      pickRanges:    slotRanges(picks),
      // Does the block start / end the shift (breaks and the "30" tail aside)?
      firstHourPick: picks[0] === inShift[0],
      lastHourPick:  picks.at(-1) === inShift.at(-1),
    });
  }
  return out;
}

/** Contiguous slot runs → [startMin, endMin) ranges. */
function slotRanges(slots) {
  const out = [];
  for (const k of slots) {
    const start = (SLOT_START_HOUR + k) * 60, end = start + 60;
    const last = out.at(-1);
    if (last && last[1] === start) last[1] = end; else out.push([start, end]);
  }
  return out;
}

/** Minutes of `ranges` that fall inside [from, to). */
function within(ranges, from, to) {
  let m = 0;
  for (const [a, b] of ranges) m += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return m;
}

/** `within`, less the part of it spent on a punched meal ([out, in] minutes, or null). */
function withinLessMeal(ranges, from, to, meal) {
  let m = within(ranges, from, to);
  if (meal) {
    const [mo, mi] = meal;
    for (const [a, b] of ranges) {
      m -= Math.max(0, Math.min(b, to, mi) - Math.max(a, from, mo));
    }
  }
  return m;
}

/** "8a–10a, 3p–4p" for a set of Pick ranges. */
export function rangesText(ranges) {
  const t = (min) => { const h = Math.floor(min / 60) % 24, mm = min % 60; return `${((h + 11) % 12) + 1}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`; };
  return (ranges || []).map(([a, b]) => `${t(a)}–${t(b)}`).join(", ");
}

/** Grid rows whose first hour is Pick (the late-start population). */
export function firstHourPickers(roster) {
  return scheduledPickers(roster).filter((p) => p.firstHourPick);
}

/** Every roster name that needs punches for these days: everyone scheduled to pick. */
export function clockInCandidates(assignmentsByDate) {
  const names = new Set();
  for (const doc of Object.values(assignmentsByDate || {}))
    for (const p of scheduledPickers(doc?.associates)) names.add(p.name);
  return [...names].sort();
}

/** { iso: { rosterName: { first, last } } } in minutes, from the pick metrics. */
function scans(rawData, assignmentsByDate) {
  const out = {};
  let lastDate = null;
  for (const row of rawData || []) {
    const date = row["Pick Date"] ? dateKey(row["Pick Date"]) : lastDate;
    if (row["Pick Date"]) lastDate = date;
    const roster = assignmentsByDate?.[date]?.associates;
    if (!row.Associate || !roster) continue;
    const match = findAssignmentMatch(row.Associate, roster);
    if (!match) continue;
    const f = parseClock(row["Min. First Scan"]);
    const l = parseClock(row["Max. Last Scan"]);
    if (!f && !l) continue;
    const day = (out[date] ||= {});
    const rec = (day[match.name] ||= { first: null, last: null });
    if (f) { const m = f.hour * 60 + f.minutes; rec.first = rec.first == null ? m : Math.min(rec.first, m); }
    if (l) { const m = l.hour * 60 + l.minutes; rec.last  = rec.last  == null ? m : Math.max(rec.last, m); }
  }
  return out;
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const avg = (xs) => xs.length ? Math.round(sum(xs) / xs.length) : null;

/**
 * @param clockIns { iso: { rosterName: { clockIn, clockOut } } }  (minutes since midnight)
 * @returns { days: [...], people: [...], totals }
 *   day = { date, name, schedStart, schedEnd, pickStart, pickEnd, clockIn, clockOut, firstPick, lastPick,
 *           clockLate, clockToPick, lost, earlyOut, endGap, total }
 *     clockLate   minutes late to the clock (negative = early); counted as late only past CLOCK_GRACE_MIN
 *     clockToPick clock-in → first pick (when the pick block starts the shift)
 *     lost        Pick-hour minutes between the start of picking and the first pick — from the clock-in
 *                 (else scheduled start) when the Pick hours open the shift, else from the first Pick slot;
 *                 a punched meal inside it is taken out; counted when over PICK_START_GRACE_MIN, else 0
 *     earlyOut    scheduled end → clock-out, positive = left early (negative = stayed); counted only past CLOCK_GRACE_MIN
 *     endGap      Pick-hour minutes between the last pick and the end of picking — to the clock-out
 *                 (else scheduled end) when the Pick hours close the shift, else to the last Pick slot;
 *                 a punched meal inside it is taken out; counted when over PICK_START_GRACE_MIN, else 0
 *     startMoved  true when `lost` is over MOVED_MIN — most likely another role, board not updated
 *     endMoved    same for `endGap`
 *     total       lost + endGap, gaps flagged as moved excluded
 *     moved       the gaps flagged as moved, summed
 *   person = { name, days, dayCount, total, moved, movedDays, totalLate, lateClockDays, avgClockLate,
 *              avgClockToPick, totalLost, totalEarlyOut, earlyOutDays, totalEndGap }
 *     totalLost / totalEndGap count only the gaps that were not flagged as moved
 */
export function firstHourStarts(assignmentsByDate, rawData, clockIns = {}) {
  const scanned = scans(rawData, assignmentsByDate);
  const days = [];
  for (const [date, doc] of Object.entries(assignmentsByDate || {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const p of scheduledPickers(doc?.associates)) {
      const punch = clockIns?.[date]?.[p.name] || {};
      const clockIn  = punch.clockIn  ?? null;
      const clockOut = punch.clockOut ?? null;
      const scan = scanned[date]?.[p.name] || {};
      const firstPick = scan.first ?? null;
      const lastPick  = scan.last  ?? null;
      if (clockIn == null && firstPick == null && clockOut == null && lastPick == null) continue;
      // Where picking was supposed to start and stop for this person today.
      // When the Pick hours open or close the shift, the punch is the edge,
      // and the minutes between the punch and the block are on the clock,
      // not picking, so they count as well.
      const startRef = p.firstHourPick ? (clockIn  ?? p.schedStart) : p.pickStart;
      const endRef   = p.lastHourPick  ? (clockOut ?? p.schedEnd)   : p.pickEnd;
      // A punched meal is time off, wherever the board had put lunch; it
      // never counts against anyone. Only the meal is punched — the 15-minute
      // breaks are not, so they stay inside the gaps.
      const meal = punch.mealOut != null && punch.mealIn != null && punch.mealIn > punch.mealOut
        ? [punch.mealOut, punch.mealIn] : null;
      const idle = (gap) => (gap > PICK_START_GRACE_MIN ? gap : 0);
      const lost = firstPick == null ? null : idle(
        withinLessMeal(p.pickRanges, startRef, firstPick, meal) +
        (p.firstHourPick ? withinLessMeal([[startRef, p.pickStart]], startRef, firstPick, meal) : 0));
      const endGap = lastPick == null ? null : idle(
        withinLessMeal(p.pickRanges, lastPick, endRef, meal) +
        (p.lastHourPick ? withinLessMeal([[p.pickEnd, endRef]], lastPick, endRef, meal) : 0));
      const startMoved = lost   != null && lost   > MOVED_MIN;
      const endMoved   = endGap != null && endGap > MOVED_MIN;
      days.push({
        date, name: p.name, schedStart: p.schedStart, schedEnd: p.schedEnd,
        pickStart: p.pickStart, pickEnd: p.pickEnd, pickRanges: p.pickRanges,
        clockIn, clockOut, mealOut: meal?.[0] ?? null, mealIn: meal?.[1] ?? null, firstPick, lastPick,
        clockLate:   clockIn != null ? clockIn - p.schedStart : null,
        clockToPick: p.firstHourPick && clockIn != null && firstPick != null ? firstPick - clockIn : null,
        lost, endGap, startMoved, endMoved,
        earlyOut:    clockOut != null ? p.schedEnd - clockOut : null,
        total:       (startMoved ? 0 : lost ?? 0) + (endMoved ? 0 : endGap ?? 0),
        moved:       (startMoved ? lost : 0) + (endMoved ? endGap : 0),
      });
    }
  }

  const byName = new Map();
  for (const d of days) {
    const p = byName.get(d.name) || byName.set(d.name, { name: d.name, days: [] }).get(d.name);
    p.days.push(d);
  }
  const people = [...byName.values()].map((p) => {
    const pick = (k) => p.days.map((d) => d[k]).filter((x) => x != null);
    const late = pick("clockLate").filter((m) => m > CLOCK_GRACE_MIN), early = pick("earlyOut").filter((m) => m > CLOCK_GRACE_MIN);
    return {
      name: p.name, days: p.days, dayCount: p.days.length,
      total: sum(pick("total")),
      moved: sum(pick("moved")), movedDays: p.days.filter((d) => d.moved > 0).length,
      totalLate: sum(late), lateClockDays: late.length,
      avgClockLate: avg(pick("clockLate")), avgClockToPick: avg(pick("clockToPick")),
      totalLost: sum(p.days.filter((d) => !d.startMoved).map((d) => d.lost).filter((x) => x != null)),
      totalEarlyOut: sum(early), earlyOutDays: early.length,
      totalEndGap: sum(p.days.filter((d) => !d.endMoved).map((d) => d.endGap).filter((x) => x != null)),
    };
  }).sort((a, b) => b.total - a.total || b.totalLate - a.totalLate);

  return {
    days, people,
    totals: {
      associates: people.length,
      withClock: days.filter((d) => d.clockIn != null).length,
      idleMinutes: sum(people.map((p) => p.total)),
      movedMinutes: sum(people.map((p) => p.moved)),
      movedDays: sum(people.map((p) => p.movedDays)),
      lateMinutes: sum(people.map((p) => p.totalLate)),
      lateClockDays: sum(people.map((p) => p.lateClockDays)),
      lostMinutes: sum(people.map((p) => p.totalLost)),
      avgClockToPick: avg(days.map((d) => d.clockToPick).filter((x) => x != null)),
      earlyOutMinutes: sum(people.map((p) => p.totalEarlyOut)),
      earlyOutDays: sum(people.map((p) => p.earlyOutDays)),
      endGapMinutes: sum(people.map((p) => p.totalEndGap)),
    },
  };
}

/** 13*60+5 → "1:05 PM" */
export function clockText(min) {
  if (min == null) return "—";
  const h24 = Math.floor(min / 60) % 24, m = min % 60;
  return `${((h24 + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}
