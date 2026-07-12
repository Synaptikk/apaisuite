// modules/claimsdisposition/lib/looker_csv.js
//
// Tiny CSV writer used by the Pull → "Download CSVs" path. Renamed from
// lib/csv.js (which already exists as a CSV READER) so the two files don't
// collide. The reader parses fetched-from-server CSV text into row objects;
// this writer serializes pulled row objects back into CSV text for the
// chrome.downloads.download Blob URL.
//
// Spec compliance: RFC 4180-ish. Wraps any field containing comma, quote,
// CR, or LF in double quotes; escapes embedded quotes by doubling. Numbers
// and null/undefined pass through as their string form (null/undefined → "").

export function toCsv(rows, { columns } = {}) {
  if (!rows.length && !columns) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const lines = [cols.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeField(row?.[c])).join(","));
  }
  // Trailing newline is conventional and helps tools like Excel detect EOF.
  return lines.join("\r\n") + "\r\n";
}

function escapeField(v) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  // Quote if the field contains any CSV-significant character. The double-
  // quote check must come BEFORE the regex test so `"` alone is also quoted.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
