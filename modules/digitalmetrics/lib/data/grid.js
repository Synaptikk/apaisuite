// modules/digitalmetrics/lib/data/grid.js
//
// The assignment grid's domain rules: time slots, task vocabulary, per-slot
// staffing summary, fill percentage, and the finalise rule. Pure.

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

// Estimated picks per picker per hour. A planning figure, not a measurement —
// the grid uses it to answer "is this enough people for the volume?".
export const PICKS_PER_PICKER_HOUR = 75;

export function resolveShortcut(key) {
  if (key in TASK_SHORTCUTS) return TASK_SHORTCUTS[key];
  const lower = key?.toLowerCase?.();
  return lower && lower in TASK_SHORTCUTS ? TASK_SHORTCUTS[lower] : undefined;
}

/**
 * Is this slot only half worked?
 *
 * A shift starting at 5:30 works half of the 5-6 slot, and one ending at 1:30
 * works half of 1-2P. Half slots are excluded from staffing counts entirely
 * rather than counted as 0.5 — the summary answers "how many people are on
 * this task right now", and half a person is not a useful answer.
 */
export function isHalfSlot(assoc, slotIdx) {
  const label = assoc?.shiftLabel;
  if (typeof label !== "string") return false;

  const [start, end] = label.split("-").map((s) => s?.trim());
  if (!start || !end) return false;

  if (slotIdx === assoc.shiftStart      && start.includes(":30")) return true;
  if (slotIdx === assoc.shiftEnd - 1    && end.includes(":30"))   return true;
  return false;
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

    for (let i = 0; i < TIME_SLOTS.length; i++) {
      const actual     = assoc.slots?.[i];
      const suggestion = !actual ? suggestions[assoc.name]?.[i]?.task : null;
      const task       = (actual || suggestion || "").toUpperCase();
      if (!task) continue;

      const row = SUMMARY_TASKS.find((t) => t.task === task);
      if (!row) continue;

      const weight = isHalfSlot(assoc, i) ? 0 : 1;
      counts[row.key][i] += weight;
      if (!actual) suggested[row.key][i] += weight;
    }
  }

  return {
    counts,
    suggested,
    estimatedPicks: counts.pickers.map((n) => n * PICKS_PER_PICKER_HOUR),
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
