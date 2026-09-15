// modules/digitalmetrics/lib/data/express.js
//
// Express Pickup daily totals: what the Metric Overview sheet hands back, how
// it sits inside a week document, and how a week document is merged when a
// pull rewrites it. Pure.
//
// Storage shape (stores/{store}/weeks/{weekStart}.express):
//   { "2026-09-14": { orders: 33, units: 589, sales: 3074.11, pulledAt: ISO } }
//
// Keyed by ISO date, unlike rawData's "Pick Date" (M/D/YY) — the pull works in
// ISO and the two are bridged by isoFromPickDate() at read time.

import { parsePickDate } from "./parse.js";
import { isoDay } from "../pull_schedule.js";

/** The fields a per-day entry may carry. codec.js allowlists exactly these. */
export const EXPRESS_FIELDS = ["orders", "units", "sales", "pulledAt"];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Tableau writes the string "Null" for a missing measure. */
const isMissing = (v) => v === "Null" || v === null || v === undefined || v === "";

function toNumber(v) {
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The Overview sheet's melted rows → `{ orders, units, sales }`.
 *
 * Rows are one per (BU, REGION, MARKET, STORE, Measure Names). When `store`
 * is given, rows carrying a STORE column for a different store are ignored,
 * so a subtotal or a second store can never inflate the number. "Null"
 * measures count as 0: the row existing means the day was in scope.
 */
export function parseOverview(rows, { store = null } = {}) {
  const want = { ORDERS: "orders", UNITS: "units", SALES: "sales" };
  const out = { orders: 0, units: 0, sales: 0 };
  for (const row of rows || []) {
    if (store != null && row.STORE !== undefined && String(row.STORE) !== String(store)) continue;
    const key = want[String(row["Measure Names"] ?? "").trim().toUpperCase()];
    if (!key) continue;
    const v = row["Measure Values"];
    if (isMissing(v)) continue;
    const n = toNumber(v);
    if (n !== null) out[key] += n;
  }
  out.sales = Math.round(out.sales * 100) / 100;
  return out;
}

/** "9/14/26" or "9/14/2026" → "2026-09-14"; null when unparseable. */
export function isoFromPickDate(label) {
  const d = parsePickDate(label);
  return d ? isoDay(d) : null;
}

/** The express entry for a rawData Pick Date label, or null when not pulled. */
export function expressForLabel(express, label) {
  if (!express) return null;
  const iso = isoFromPickDate(label);
  return (iso && express[iso]) || null;
}

/**
 * Forward-fill the sparse Pick Date column and RETURN rows with the date made
 * explicit. Excel imports leave the date blank on every row but the first of
 * a day; a merge that filters rows by their own date must not lose them.
 */
function withExplicitDates(rows) {
  let last = null;
  return (rows || []).map((row) => {
    if (row["Pick Date"]) last = row["Pick Date"];
    return last && !row["Pick Date"] ? { ...row, "Pick Date": last } : row;
  });
}

/**
 * Merge a freshly pulled week document into the one already stored.
 *
 * The adapter's put() REPLACES the whole document, and a pull only fetches
 * the dates that are missing or still volatile — so writing the pulled slice
 * as-is wiped every other day of the week, and the next run pulled them back
 * (the document flapped between complete and partial). This keeps the stored
 * rows for every date the pull did NOT cover.
 *
 * @param existing  the stored document (decoded), or null
 * @param incoming  the document built from this pull
 * @param dates     ISO dates the METRICS pull covered — stored rows for these
 *                  dates are replaced by the incoming rows (even when incoming
 *                  has none for a date: the source now says the day is empty)
 */
export function mergeWeekDoc(existing, incoming, { dates = [] } = {}) {
  const replaced = new Set(dates);
  for (const row of incoming?.rawData || []) {
    const iso = isoFromPickDate(row["Pick Date"]);
    if (iso) replaced.add(iso);
  }

  const kept = withExplicitDates(existing?.rawData).filter((row) => {
    // A row whose name could not be decrypted has already lost its identity;
    // re-saving it would store the placeholder as if it were the name.
    if (row.Associate === "(unreadable)") return false;
    const iso = isoFromPickDate(row["Pick Date"]);
    return iso && !replaced.has(iso);
  });

  const express = { ...(existing?.express || {}), ...(incoming?.express || {}) };
  for (const k of Object.keys(express)) if (!ISO_RE.test(k)) delete express[k];

  return {
    ...(existing || {}),
    ...(incoming || {}),
    rawData: [...kept, ...(incoming?.rawData || [])],
    express: Object.keys(express).length ? express : null,
    fileName:   incoming?.fileName   ?? existing?.fileName   ?? null,
    uploadDate: incoming?.uploadDate ?? existing?.uploadDate ?? null,
  };
}
