// modules/digitalmetrics/lib/data/clock.js
//
// Parse the clock time out of a "Min. First Scan" value. Pure.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ Why this exists as its own file.                                     │
// │                                                                      │
// │ Three call sites each carried their own copy of                      │
// │                                                                      │
// │     /(\d+):(\d+)\s*(AM|PM)/i                                         │
// │                                                                      │
// │ which is wrong on the format the data actually arrives in. Tableau's │
// │ MIN(First Scan) includes SECONDS:                                    │
// │                                                                      │
// │     "8/22/2026 1:08:37 PM"                                           │
// │                                                                      │
// │ `\s*` cannot bridge the ":37 " between the minute group and the      │
// │ meridiem, so the engine backtracks and matches further along —       │
// │ landing on "08:37 PM" and reporting hour 8. Every hour derived this  │
// │ way was really a MINUTE value.                                       │
// │                                                                      │
// │ Observed 2026-08-26: the Insights "peak hours" read 21 PM, 18 PM,    │
// │ 11 PM, 7 PM, 1 AM. 21 PM is formatHour(33) — minute :21 plus the     │
// │ twelve added for PM. Nonsense hours were the visible symptom; late   │
// │ starts and is5amAssociate were quietly wrong on the same fault.      │
// └──────────────────────────────────────────────────────────────────────┘

// Seconds optional, meridiem optional. Two details carry the whole fix:
//
//   · the optional seconds group means the hour cannot slide onto the minutes
//     when a timestamp carries them;
//   · `(?<!\d)` rather than `\b` guards the hour. A word boundary fails on ISO
//     timestamps — in "2026-08-22T21:00:00" there is no boundary between "T"
//     and "21" (both word characters), so the match skipped ahead to "00:00"
//     and reported midnight. "Not preceded by a digit" keeps the hour from
//     starting mid-number while still allowing a letter in front of it.
const CLOCK_RE = /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i;

/**
 * → { hour: 0–23, minutes: 0–59, hadMeridiem } or null.
 *
 * Without AM/PM the value is read as 24-hour, which is what the scheduler's
 * ISO timestamps use.
 */
export function parseClock(value) {
  if (typeof value !== "string") return null;
  const m = CLOCK_RE.exec(value);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const meridiem = m[4] ? m[4].toUpperCase() : null;

  if (!Number.isFinite(hour) || !Number.isFinite(minutes)) return null;
  if (minutes > 59) return null;

  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  // A 12-hour reading can never exceed 23; a 24-hour one must not either.
  if (hour > 23) return null;

  return { hour, minutes, hadMeridiem: meridiem !== null };
}

/** Hour of day 0–23, or null. */
export function scanHour(firstScan) {
  return parseClock(firstScan)?.hour ?? null;
}

/**
 * Minutes past 5:00 for a 5am start, or null when the row is not one.
 *
 * `maxMinute` exists because "5:51"–"5:59" is an early 6am start, not a late
 * 5am one.
 */
export function minutesPastFive(firstScan, maxMinute) {
  const c = parseClock(firstScan);
  if (!c) return null;
  if (c.hour !== 5 || c.minutes > maxMinute) return null;
  return c.minutes;
}
