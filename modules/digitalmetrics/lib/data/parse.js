// modules/digitalmetrics/lib/data/parse.js
//
// Turns a parsed "Associate By Day" sheet into per-store, per-week documents.
// Pure — the caller does the XLSX read and the persisting.
//
// The source report is sparse by design: `Pick Date` and `Store #` are printed
// only on the first row of each group and left blank on every row beneath, so
// both columns must be forward-filled before anything can be grouped. A single
// uploaded file routinely spans several stores AND several weeks.

import { weekKey } from "./weeks.js";

/**
 * Read a Pick Date cell as a local Date.
 *
 * The sheet normally yields "MM/DD/YY" strings, but SheetJS returns a real
 * Date when a cell is date-typed, and the donor's string-only check silently
 * dropped those rows from every group. Both are handled here.
 */
export function parsePickDate(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  if (typeof value !== "string") return null;

  const parts = value.split("/");
  if (parts.length !== 3) return null;

  const [m, d, y] = parts.map((p) => parseInt(p, 10));
  if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) return null;

  // Two-digit years in this report are always 20xx.
  return new Date(y < 100 ? y + 2000 : y, m - 1, d);
}

/** Normalise a Store # cell ("1458", 1458, 1458.0) to a bare string. */
export function normalizeStore(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.floor(n)) : String(value).trim() || null;
}

/**
 * Forward-fill the two sparse columns, returning rows annotated with the
 * resolved date and store. Original columns are left untouched.
 */
export function forwardFill(rows) {
  let lastDate  = null;
  let lastStore = null;

  return (rows || []).map((row) => {
    const parsed = parsePickDate(row["Pick Date"]);
    if (parsed) lastDate = parsed;

    const store = normalizeStore(row["Store #"]);
    if (store) lastStore = store;

    return { ...row, _date: lastDate, _store: lastStore };
  });
}

/**
 * Group an uploaded sheet into one document per (store, week).
 *
 * Returns [{ store, weekKey, doc }] ready to hand to firestore.weeks.put().
 * Rows with no resolvable date or store are dropped and counted in `skipped`
 * rather than silently vanishing.
 */
export function splitByStoreWeek(rows, { fileName = null, uploadDate = null } = {}) {
  const groups = new Map();
  let skipped = 0;

  for (const row of forwardFill(rows)) {
    const { _date, _store, ...original } = row;
    if (!_date || !_store) { skipped++; continue; }

    const key = weekKey(_date);
    const id  = `${_store}_${key}`;
    if (!groups.has(id)) groups.set(id, { store: _store, weekKey: key, rows: [] });
    groups.get(id).rows.push(original);
  }

  const out = [...groups.values()].map(({ store, weekKey: key, rows: r }) => ({
    store,
    weekKey: key,
    doc: {
      rawData:    r,
      fileName,
      uploadDate: uploadDate ?? new Date().toISOString(),
      store,
      weekStart:  key,
    },
  }));

  return { groups: out, skipped };
}
