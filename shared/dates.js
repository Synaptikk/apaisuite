// shared/dates.js
//
// Weekday tagging for user-visible dates. Everywhere a module shows a date
// ("9/27/2026", "2026-09-27", a locale string) it should carry the short
// weekday too — "Sat 9/27/2026" — because the store runs on weekdays
// (truck days, board days, weekend spikes), not calendar numbers.
//
// Pure; safe in both the shell page and the service worker.

export const WEEKDAYS_SHORT = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

/**
 * Short weekday name ("Sat") for a Date, epoch ms, or string.
 *
 * Date-only strings ("2026-09-27", "9/27/2026", and either with a trailing
 * time like "2026-09-27 14:05") are read as STORE-LOCAL calendar dates —
 * never `new Date("YYYY-MM-DD")`, which parses as UTC midnight and names
 * the previous weekday for everyone west of Greenwich.
 * Returns "" when the value doesn't parse.
 */
export function weekdayOf(value) {
  let d = null;
  if (value instanceof Date) d = value;
  else if (typeof value === "number") d = new Date(value);
  else if (typeof value === "string") {
    let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);           // ISO-ish, date first
    if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
    else if ((m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)))  // US M/D/YYYY
      d = new Date(+m[3], +m[1] - 1, +m[2]);
    else d = new Date(value);
  }
  return d && !Number.isNaN(d.getTime()) ? WEEKDAYS_SHORT[d.getDay()] : "";
}

/**
 * Prefix a rendered date with its weekday: withWeekday("9/27/2026") →
 * "Sat 9/27/2026". Pass `value` separately when the display text alone
 * can't be parsed (already formatted, truncated, etc.):
 * withWeekday("09-27 14:05", row.isoDate). Unparseable → text unchanged.
 */
export function withWeekday(text, value = text) {
  const w = weekdayOf(value);
  return w ? `${w} ${text}` : String(text ?? "");
}
