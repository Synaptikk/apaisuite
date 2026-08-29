// modules/digitalmetrics/lib/data/grid.js
//
// The assignment grid's domain rules: time slots, task vocabulary, per-slot
// staffing summary, fill percentage, and the finalise rule. Pure.

import { parseClock } from "./clock.js";

export const TIME_SLOTS = [
  "5-6", "6-7", "7-8", "8-9", "9-10", "10-11", "11-12", "12-1P", "1-2P",
  "2-3P", "3-4P", "4-5P", "5-6P", "6-7P", "7-8P", "8-9P", "9-10P",
];

export const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Keyboard shortcuts. Lower and upper case both map, and three keys clear a
// cell.
//
// The mnemonic is the task's own letter wherever it is still free, and a
// distinctive letter from the word where it is not: DISP already owns D, so
// Drivers takes the V of "driVer" and Downstacker the N of "dowNstacker";
// PICK owns P, so Prep takes R.
//
// This object is the single source of truth for the legend as well. It used to
// print label[0], which was simply wrong — it showed P for Prep (the actual key
// is R) and P again for Pick, so two entries claimed the same key and one of
// them did nothing.
export const TASK_SHORTCUTS = {
  p: "PICK", d: "DISP", s: "STAGE", r: "PREP",
  q: "QC", v: "DRV", n: "DS", t: "TRN",
  i: "IP", e: "EXC", l: "L", b: "B", 3: "30",
  x: "", Delete: "", Backspace: "",
};

/**
 * Display labels for the task codes, so the legend and the mobile panel read
 * as words rather than as the abbreviations the cells carry.
 */
export const TASK_LABELS = {
  PICK: "Pick", DISP: "Disp", STAGE: "Stage", PREP: "Prep",
  QC: "Quality", DRV: "Drivers", DS: "Downstack", TRN: "Training",
  IP: "IP", EXC: "Exc", L: "Lunch", B: "Break", 30: "30",
};

/** Tasks that appear as their own summary row, in display order. */
export const SUMMARY_TASKS = [
  { key: "pickers", task: "PICK",  label: "Pickers" },
  { key: "disp",    task: "DISP",  label: "Dispense" },
  { key: "stage",   task: "STAGE", label: "Stage" },
  { key: "prep",    task: "PREP",  label: "Prep" },
  { key: "qc",      task: "QC",    label: "Quality" },
  { key: "drv",     task: "DRV",   label: "Drivers" },
  { key: "ds",      task: "DS",    label: "Downstack" },
  { key: "trn",     task: "TRN",   label: "Training" },
  { key: "exc",     task: "EXC",   label: "Exception" },
];

/**
 * Is this associate absent?
 *
 * Absence is the one status that changes the arithmetic: an absent person's
 * cells may still hold whatever was planned for them, but they are not there
 * to do it, so counting those tasks overstates the day's cover.
 */
export const isAbsent = (assoc) => assoc?.status === "absent";

/**
 * Is this a leadership row (coach or team lead)?
 *
 * They are on the board so their day can be seen and, when needed, overridden
 * — not because they are cover. A coach counted as a picker overstates the
 * hour and inflates the estimated picks derived from it.
 */
export const isLeadership = (assoc) => assoc?.role === "TL" || assoc?.role === "COACH";

// Estimated picks per picker per hour. A planning figure, not a measurement —
// the grid uses it to answer "is this enough people for the volume?".
export const PICKS_PER_PICKER_HOUR = 75;

export function resolveShortcut(key) {
  if (key in TASK_SHORTCUTS) return TASK_SHORTCUTS[key];
  const lower = key?.toLowerCase?.();
  return lower && lower in TASK_SHORTCUTS ? TASK_SHORTCUTS[lower] : undefined;
}

/** The grid's first column is the 5am hour. */
const SLOT_START_HOUR = 5;

/**
 * The shift's true start and end, in minutes past midnight.
 *
 * shiftStart/shiftEnd on a grid row are SLOT INDICES — whole hours, because
 * toSlot() floors. The real clock times survive only on shiftLabel
 * ("5:40am-2:10pm"), so that is what has to be read to know how much of an
 * hour someone actually works.
 *
 * Both times are pulled with one global match rather than by splitting on "-".
 * A split works today because formatTime never emits a hyphen, but it is one
 * format change away from silently returning nonsense.
 */
function shiftMinutes(assoc) {
  const label = assoc?.shiftLabel;
  if (typeof label !== "string") return null;

  const times = label.match(/\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]?[Mm]?/g);
  if (!times || times.length < 2) return null;

  const a = parseClock(times[0]);
  const b = parseClock(times[1]);
  if (!a || !b) return null;

  const startMin = a.hour * 60 + a.minutes;
  const endMin   = b.hour * 60 + b.minutes;
  // An overnight shift (10pm-7am) has no honest representation on a 5am-10pm
  // grid and is already clamped upstream; fractional coverage would be a lie
  // on top of a clamp, so leave those to the whole-slot fallback.
  if (endMin <= startMin) return null;

  return { startMin, endMin };
}

/**
 * How much of this slot the associate actually works: 0, 0.5, or 1.
 *
 * The old rule was binary and string-matched ":30" on the label, so it caught
 * exactly one case. A :40 start — common on this roster — matched nothing and
 * counted as a WHOLE person for an hour they work 20 minutes of, inflating
 * both the staffing line and the estimated picks derived from it. Anything
 * that was caught went the other way and counted as ZERO, which understated
 * the same numbers.
 *
 * Quantised to halves rather than reported exactly. A 40-minute slot is 0.67
 * of an hour, and a summary row reading "2.7" invites arithmetic nobody wants
 * to do; halves say "someone is here for part of this hour" at the precision
 * a staffing decision is actually made at. It also keeps the headcount and the
 * estimated picks consistent, since picks derive from this same number.
 */
export function slotCoverage(assoc, slotIdx) {
  const inShift = typeof assoc?.shiftStart === "number"
               && typeof assoc?.shiftEnd === "number"
               && slotIdx >= assoc.shiftStart && slotIdx < assoc.shiftEnd;

  const bounds = shiftMinutes(assoc);
  // No readable times — fall back to the whole-slot view rather than guessing.
  if (!bounds) return inShift ? 1 : 0;

  const slotStart = (SLOT_START_HOUR + slotIdx) * 60;
  const overlap = Math.min(bounds.endMin, slotStart + 60) - Math.max(bounds.startMin, slotStart);
  if (overlap <= 0) return 0;

  return Math.round(Math.min(overlap, 60) / 60 * 2) / 2;
}

/**
 * Is this slot only partly worked? Kept for the cell styling, now derived from
 * the coverage above so the tint and the arithmetic can never disagree.
 */
export function isHalfSlot(assoc, slotIdx) {
  const c = slotCoverage(assoc, slotIdx);
  return c > 0 && c < 1;
}

/**
 * WHICH half of a partly-worked slot is not worked: "lead" (the associate
 * arrives partway through) or "trail" (they leave partway through).
 *
 * The old wedge was a single diagonal that meant "partial" without saying
 * which end, so a 5:40 start and a 5:20 finish drew identically. Knowing the
 * side is what lets the unworked half be shaded like the blocked-out hours
 * either side of it, which is the whole point — the eye reads the shift's real
 * edge instead of a decoration.
 */
export function partialSide(assoc, slotIdx) {
  if (!isHalfSlot(assoc, slotIdx)) return null;
  const bounds = shiftMinutes(assoc);
  if (!bounds) return null;
  const slotStart = (SLOT_START_HOUR + slotIdx) * 60;
  // Starts inside this hour → the earlier part is unworked.
  if (bounds.startMin > slotStart) return "lead";
  if (bounds.endMin < slotStart + 60) return "trail";
  return null;
}

/**
 * Per-slot staffing counts.
 *
 * Unfilled cells fall back to their suggestion, so the summary shows what the
 * day WOULD look like if the suggestions were accepted. Suggested headcount is
 * tracked separately so the UI can show "4 (2)" — four people, two of them
 * only proposed.
 */
export function summarise(assignments, suggestions = {}) {
  const blank = () => Array(TIME_SLOTS.length).fill(0);
  const counts    = Object.fromEntries(SUMMARY_TASKS.map((t) => [t.key, blank()]));
  const suggested = Object.fromEntries(SUMMARY_TASKS.map((t) => [t.key, blank()]));

  for (const assoc of assignments || []) {
    // An absent associate contributes nothing. Their cells are left as they
    // were — marking someone absent must not destroy the plan, and it has to
    // be undoable — but the counts are a statement about who is actually on
    // the floor, and they are not.
    if (isAbsent(assoc)) continue;

    // Leadership does not count as cover. An explicitly assigned task is a
    // deliberate override and DOES count — the exclusion is about their
    // default role, not about ignoring a decision someone made on purpose.
    if (isLeadership(assoc) && !Object.keys(assoc.slots || {}).length) continue;

    for (let i = 0; i < TIME_SLOTS.length; i++) {
      const actual     = assoc.slots?.[i];
      const suggestion = !actual ? suggestions[assoc.name]?.[i]?.task : null;
      const task       = (actual || suggestion || "").toUpperCase();
      if (!task) continue;

      const row = SUMMARY_TASKS.find((t) => t.task === task);
      if (!row) continue;

      // Fractional: a 5:40 start works a third of the 5-6 hour, not none of it
      // and not all of it. Both readings were wrong in opposite directions.
      const weight = slotCoverage(assoc, i);
      if (weight <= 0) continue;
      counts[row.key][i] += weight;
      if (!actual) suggested[row.key][i] += weight;
    }
  }

  return {
    counts,
    suggested,
    // Whole picks. The headcount is deliberately fractional; a projected
    // "112.5 picks" is false precision on a planning figure.
    estimatedPicks: counts.pickers.map((n) => Math.round(n * PICKS_PER_PICKER_HOUR)),
  };
}

/**
 * Share of in-shift cells that carry a task.
 *
 * Only slots inside an associate's shift count — an 8am starter's 5am cell is
 * not an unfilled assignment, and counting it would make every day look empty.
 */
export function fillPercentage(assignments) {
  let total = 0;
  let filled = 0;

  for (const a of assignments || []) {
    // Absent associates drop out of the denominator too. Leaving them in makes
    // a fully-planned day read as under-filled purely because someone called
    // in, which is the opposite of what the number is for.
    if (isAbsent(a)) continue;
    // Same for the fill percentage: a leadership row is not an unfilled
    // assignment waiting to be made.
    if (isLeadership(a) && !Object.keys(a.slots || {}).length) continue;

    const start = typeof a.shiftStart === "number" ? a.shiftStart : 0;
    const end   = typeof a.shiftEnd   === "number" ? a.shiftEnd   : TIME_SLOTS.length;
    for (let i = start; i < end; i++) {
      total++;
      if (a.slots?.[i]?.trim()) filled++;
    }
  }
  return total > 0 ? (filled / total) * 100 : 0;
}

/**
 * Should this day be treated as locked?
 *
 * A past day that was substantially filled in is finished, and editing it
 * would corrupt the history that adherence is measured against — so it locks
 * itself. An explicit `finalized: false` always wins, so a genuine correction
 * is still possible.
 */
export function isFinalized(doc, { today = new Date() } = {}) {
  if (doc?.finalized === true)  return true;
  if (doc?.finalized === false) return false;   // explicitly unfinalised

  const date = doc?.date;
  if (!date) return false;

  const todayKey = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");

  return date < todayKey && fillPercentage(doc.associates) >= 50;
}

/** Day-of-week label for an ISO date. */
export function dayName(isoDate) {
  if (!isoDate) return "";
  return DAY_NAMES[new Date(`${isoDate}T00:00:00`).getDay()];
}

/** A blank row for a newly added associate. */
export function emptyAssociate(name) {
  return { name, slots: {}, status: null, shiftStart: null, shiftEnd: null, shiftLabel: null };
}

/** Tomorrow in YYYY-MM-DD — the grid plans ahead by default. */
export function defaultDate(today = new Date()) {
  const d = new Date(today);
  d.setDate(d.getDate() + 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
}
