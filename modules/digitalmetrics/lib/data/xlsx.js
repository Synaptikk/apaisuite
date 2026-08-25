// modules/digitalmetrics/lib/data/xlsx.js
//
// Adapts the vendored row-oriented .xlsx reader to the column-keyed row
// objects the rest of the module expects.
//
// The donor used SheetJS's sheet_to_json, which produced objects keyed by
// header and typed values. The vendored reader returns strings, so the typing
// happens here — and it has to, because data/metrics.js treats a non-number as
// zero and would silently total every metric to nothing.

import { parseXlsx } from "../../vendor/xlsx_min.js";

// Columns that must stay strings even though they look numeric-ish.
// "Pick Date" is "12/01/25" and "Min. First Scan" is a timestamp; coercing
// either would break date parsing and late-start detection.
const TEXT_COLUMNS = new Set(["Pick Date", "Min. First Scan", "Max. Last Scan", "Associate", "Store #"]);

/** "1,234.5" → 1234.5; "" → undefined; "abc" → "abc". */
export function coerce(value, column) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (s === "") return undefined;
  if (TEXT_COLUMNS.has(column)) return s;

  const cleaned = s.replace(/,/g, "").replace(/%$/, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return s;

  const n = Number(cleaned);
  // A trailing % means the sheet wrote 92.5% where the app wants 92.5.
  return Number.isFinite(n) ? n : s;
}

/**
 * Turn a sheet's rows into column-keyed objects.
 *
 * The header is the first row that contains "Associate" — the export carries
 * a title line or two above the table, and blindly taking row 0 yields a sheet
 * whose every column is named after a report title.
 */
export function rowsToObjects(rows) {
  if (!Array.isArray(rows) || !rows.length) return { headers: [], records: [] };

  const headerIdx = rows.findIndex((r) =>
    r.some((c) => String(c || "").trim().toLowerCase() === "associate"));
  if (headerIdx === -1) return { headers: [], records: [] };

  const headers = rows[headerIdx].map((h) => String(h || "").trim());

  const records = rows.slice(headerIdx + 1)
    .filter((r) => r.some((c) => String(c || "").trim() !== ""))
    .map((r) => {
      const out = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const v = coerce(r[i], h);
        if (v !== undefined) out[h] = v;
      });
      return out;
    });

  return { headers, records };
}

/** Bytes → row objects. */
export async function parseWorkbook(bytes) {
  const result = await parseXlsx(bytes);
  if (!result.ok) return { ok: false, reason: result.reason };

  const { headers, records } = rowsToObjects(result.rows);
  if (!headers.length) {
    return { ok: false, reason: "no 'Associate' header row found — is this the Associate By Day export?" };
  }
  return { ok: true, headers, records };
}
