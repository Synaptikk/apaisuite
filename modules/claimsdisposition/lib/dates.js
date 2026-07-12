// modules/claimsdisposition/lib/dates.js
//
// Date helpers — replaces date-fns. The donor used four date-fns functions
// (format, parseISO, eachDayOfInterval, startOfDay); each is implemented
// below using only the standard library.
//
// Format strings supported by `format()` are a tiny subset, just what the
// donor actually used: "MMM d, yyyy", "M/d", "yyyy-MM-dd".

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Accept either a YYYY-MM-DD string or a Date.
function asDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === "string") return parseISO(d);
  return null;
}

// Cheap subset of date-fns.format. Tokens supported:
//   MMM  -> 3-letter month
//   yyyy -> 4-digit year
//   yy   -> 2-digit year
//   d    -> day of month (no padding)
//   M    -> month (no padding)
//   MM   -> month (zero-padded)
//   dd   -> day of month (zero-padded)
export function formatDateFmt(date, pattern) {
  const d = asDate(date);
  if (!d) return "";
  // Sequential .replace() calls would let later patterns match the OUTPUT of
  // earlier ones — e.g. `MMM → "May"` then `M → "5"` would corrupt the
  // month-name "May" into "5ay". Tokenize-then-resolve so each pattern
  // matches the original input only.
  const repl = {
    MMM:  MONTH_SHORT[d.getMonth()],
    yyyy: String(d.getFullYear()),
    yy:   String(d.getFullYear()).slice(-2),
    MM:   String(d.getMonth() + 1).padStart(2, "0"),
    M:    String(d.getMonth() + 1),
    dd:   String(d.getDate()).padStart(2, "0"),
    d:    String(d.getDate()),
  };
  // Order matters here: longer tokens first so "MMM" wins over "MM"/"M".
  return pattern.replace(/MMM|yyyy|yy|MM|M|dd|d/g, (m) => repl[m]);
}

export function formatDate(d) {
  return formatDateFmt(d, "MMM d, yyyy");
}

export function formatDateShort(d) {
  return formatDateFmt(d, "M/d");
}

export function formatTimeRange(hour) {
  return `${formatHour(hour)}–${formatHour((hour + 1) % 24)}`;
}

export function formatHour(h) {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// "2026-05-27" → Date at local midnight. Matches date-fns parseISO for
// date-only strings (full ISO timestamps fall through to native Date).
export function parseISO(iso) {
  if (iso instanceof Date) return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(iso);
}

// Strip time component; returns a new Date at local midnight.
export function startOfDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

export function getDateRange(records) {
  if (!records.length) return { min: null, max: null };
  let min = records[0].timestamp;
  let max = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp < min) min = r.timestamp;
    if (r.timestamp > max) max = r.timestamp;
  }
  return { min: startOfDay(min), max: startOfDay(max) };
}

// Inclusive list of every day between min and max (local time). Returns
// [{ date: Date, iso: "YYYY-MM-DD" }, ...]. Replaces date-fns
// eachDayOfInterval + format pair.
export function listDaysBetween(min, max) {
  if (!min || !max) return [];
  const out = [];
  const cur = startOfDay(min);
  const end = startOfDay(max);
  while (cur <= end) {
    out.push({ date: new Date(cur), iso: toIsoDate(cur) });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export function isoToDate(iso) {
  return parseISO(iso);
}

export function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
