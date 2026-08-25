// modules/digitalmetrics/lib/data/tableau.js
//
// Reshapes what Tableau's JS API hands back into the row shape the rest of the
// module expects. Pure.
//
// Tableau's getSummaryDataAsync returns MELTED (long) rows — one row per
// associate per date per metric:
//
//   { Associate: "A", "Pick Date": "12/1/2025", "Measure Names": "Pick Rate",
//     "Measure Values": 85 }
//
// Everything downstream expects WIDE rows — one row per associate per date,
// with each metric as a column. Pivoting is the whole job here.

/**
 * "12/1/2025" → "12/1/25".
 *
 * The rest of the module parses a Pick Date's year as two digits and adds
 * 2000, so a four-digit year would land in the year 4025 and silently drop
 * every row out of its week.
 */
export function normalizePickDate(date) {
  if (date == null) return date;

  const parts = String(date).trim().split("/");
  if (parts.length !== 3) return date;

  const [month, day, year] = parts.map((p) => parseInt(p, 10));
  if ([month, day, year].some((n) => Number.isNaN(n))) return date;

  return `${month}/${day}/${year >= 100 ? year % 100 : year}`;
}

/** Tableau writes the string "Null" for a missing measure. */
const isMissing = (v) => v === "Null" || v === null || v === undefined || v === "";

function toNumber(value) {
  if (typeof value !== "string") return value;
  const n = parseFloat(value.replace(/,/g, ""));
  return Number.isNaN(n) ? value : n;
}

/**
 * Melted associate rows → one wide row per (associate, date).
 *
 * Identity columns arrive under either their raw or aggregated names
 * ("MIN(First Scan)" vs "Min. First Scan") depending on which worksheet the
 * export came from, so both spellings are accepted.
 */
export function pivotAssociateData(rows) {
  const byKey = new Map();

  for (const row of rows || []) {
    const associate = row["Associate"];
    const date      = normalizePickDate(row["Pick Date"]);
    if (!associate || !date) continue;

    const key = `${associate}|||${date}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        "Store #":         row["Store #"] || "",
        "Pick Date":       date,
        "Associate":       associate,
        "Min. First Scan": row["MIN(First Scan)"] || row["Min. First Scan"] || "",
      });
    }

    const measure = row["Measure Names"];
    const value   = row["Measure Values"];
    if (!measure || isMissing(value)) continue;

    byKey.get(key)[measure] = toNumber(value);
  }

  return [...byKey.values()];
}

/**
 * Split a pivoted set into the per-store, per-week documents the adapter
 * writes. Re-exported from parse.js so callers have one import for "scraped
 * data → saveable documents".
 */
export { splitByStoreWeek } from "./parse.js";
