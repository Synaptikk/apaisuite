// modules/digitalmetrics/lib/data/weeks.js
//
// Week and date arithmetic. Pure — no DOM, no storage, no network.
//
// Two conventions inherited from the donor, both load-bearing:
//   • A "week" runs Saturday → Friday, keyed by its Saturday in YYYY-MM-DD.
//   • Week 1 of a fiscal year is the week containing Feb 1 (i.e. it starts on
//     the Saturday on or before Feb 1). This is a retail fiscal calendar, not
//     an ISO one — do not swap in a standard week-number routine.
//
// Every Date built from a YYYY-MM-DD string appends T00:00:00 so it parses as
// local midnight. Without it the runtime reads bare dates as UTC and the whole
// calendar slips a day for anyone west of Greenwich.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a YYYY-MM-DD (or ISO) string as a LOCAL date. */
export function parseLocal(dateStr) {
  if (dateStr instanceof Date) return dateStr;
  const s = String(dateStr);
  return new Date(s.includes("T") ? s : `${s}T00:00:00`);
}

/** Format a Date as YYYY-MM-DD in local time (never toISOString — that's UTC). */
export function formatKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The Saturday on or before `date` — the key for the week containing it. */
export function weekKey(date) {
  const d   = parseLocal(date);
  const sat = new Date(d);
  sat.setDate(d.getDate() - ((d.getDay() + 1) % 7));
  return formatKey(sat);
}

/** The week key one week before the week containing `from` (default: today). */
export function previousWeekKey(from = new Date()) {
  const start = parseLocal(weekKey(from));
  start.setDate(start.getDate() - 7);
  return formatKey(start);
}

/** Start of fiscal week 1: the Saturday on or before Feb 1 of `fiscalYear`. */
function week1Start(fiscalYear) {
  const feb1 = new Date(fiscalYear, 1, 1);
  const start = new Date(feb1);
  start.setDate(feb1.getDate() - ((feb1.getDay() + 1) % 7));
  return start;
}

/** Fiscal week number + fiscal year for a date. */
export function weekNumber(dateStr) {
  const date = parseLocal(dateStr);
  const year = date.getFullYear();

  let start  = week1Start(year);
  let fiscal = year;

  if (date < start) {                       // before this year's week 1
    start  = week1Start(year - 1);
    fiscal = year - 1;
  }
  const next = week1Start(year + 1);
  if (date >= next) {                       // next fiscal year already began
    start  = next;
    fiscal = year + 1;
  }

  const days = Math.floor((date - start) / MS_PER_DAY);
  return { week: Math.floor(days / 7) + 1, year: fiscal };
}

/** "Week 45 (11/29 - 12/5)" */
export function formatWeekDisplay(key) {
  const { week } = weekNumber(key);
  const start = parseLocal(key);
  const end   = new Date(start);
  end.setDate(end.getDate() + 6);
  const short = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `Week ${week} (${short(start)} - ${short(end)})`;
}

/**
 * Distinct Pick Dates present in a week's rows.
 *
 * The source report only prints Pick Date on the first row of each date group,
 * leaving the rest blank, so blanks inherit the last seen value.
 */
export function datesInWeek(rawData) {
  const dates = new Set();
  let last = null;
  for (const row of rawData || []) {
    const val = row["Pick Date"];
    if (val) last = val;
    if (last) dates.add(last);
  }
  return [...dates].sort();
}
