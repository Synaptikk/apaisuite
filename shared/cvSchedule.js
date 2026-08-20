// shared/cvSchedule.js
//
// Shared, DOM-free helpers for CaseVisibility schedule data. Previously these
// functions were copy-pasted into modules/closinglist/lib/parse.js and
// modules/stockingplan/lib/compute.js (see docs/MIGRATION_PLAN.md::Phase 4).
// Consolidated here so both consumers share one implementation.
//
// NOTE on separators: closinglist renders shift ranges with a hyphen ("8am-5pm"),
// stockingplan with an en-dash ("8am–5pm"). formatShiftRange takes the separator
// as a parameter so each module keeps its exact prior output.

// --- Timestamp parsing ----------------------------------------------------
// CaseVisibility shift_*_ts strings are length 16, inferred as
// "YYYY/MM/DD HH:MM" but we accept several common alternates.
export function parseTimestamp(ts) {
  if (!ts || typeof ts !== "string") return null;
  const trimmed = ts.trim();
  // Try ISO with T first ("2026-05-22T13:00", "...:00", "...Z")
  let d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;
  // "YYYY/MM/DD HH:MM" or "YYYY-MM-DD HH:MM"
  let m = trimmed.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // "MM/DD/YYYY HH:MM"
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
  // "MM/DD/YYYY HH:MM AM/PM"
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = +m[4];
    if (/PM/i.test(m[6]) && h < 12) h += 12;
    if (/AM/i.test(m[6]) && h === 12) h = 0;
    return new Date(+m[3], +m[1] - 1, +m[2], h, +m[5]);
  }
  return null;
}

export function formatTime12h(d) {
  if (!d || isNaN(d.getTime())) return "??";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function shortPart(d) {
  if (!d || isNaN(d.getTime())) return { hm: "??", ampm: "" };
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  const minutes = m === 0 ? "" : ":" + String(m).padStart(2, "0");
  return { hm: `${h12}${minutes}`, ampm };
}

// Compact form: "8am-5pm" when ampm differs; "1:30-10:30pm" when same.
// Whole hours drop the ":00". `sep` lets each caller keep its own dash style.
export function formatShiftRange(start, end, sep = "-") {
  const s = shortPart(start);
  const e = shortPart(end);
  if (s.ampm && e.ampm && s.ampm === e.ampm) {
    return `${s.hm}${sep}${e.hm}${e.ampm}`;
  }
  return `${s.hm}${s.ampm}${sep}${e.hm}${e.ampm}`;
}

// --- Display name ---------------------------------------------------------
export function titleCase(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/(^|[\s\-'])(\S)/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Canonical associate display name from a CaseVisibility schedule row.
export function displayName(row) {
  const raw = (row.preferred_name || row.fname || "").trim();
  if (!raw) return null;
  return titleCase(raw);
}
