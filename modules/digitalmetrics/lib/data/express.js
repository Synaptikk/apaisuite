// modules/digitalmetrics/lib/data/express.js
//
// Express Pickup daily totals: what the Metric Overview sheet hands back, how
// it sits inside a week document, and how a week document is merged when a
// pull rewrites it. Pure.
//
// Storage shape (stores/{store}/weeks/{weekStart}.express):
//   { "2026-09-14": { orders: 33, units: 589, sales: 3074.11, pulledAt: ISO } }
// and, from the Associate By Day sheet filtered to Express Pickup
// (stores/{store}/weeks/{weekStart}.expressRate):
//   { "2026-09-20": { rate: 61.5, units: 1416, hours: 23.02, pickers: 36, pulledAt: ISO } }
//
// Keyed by ISO date, unlike rawData's "Pick Date" (M/D/YY) — the pull works in
// ISO and the two are bridged by isoFromPickDate() at read time.

import { parsePickDate } from "./parse.js";
import { isoDay } from "../pull_schedule.js";

/** The fields a per-day entry may carry. codec.js allowlists exactly these. */
export const EXPRESS_FIELDS = ["orders", "units", "sales", "pulledAt"];

/** The fields a per-day Express pick-rate entry may carry (codec.js too). */
export const EXPRESS_RATE_FIELDS = ["rate", "units", "hours", "pickers", "pulledAt"];

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

/**
 * Associate By Day rows (melted, filtered to Express Pickup) → per-day
 * Express pick rate, keyed by ISO date.
 *
 * The dashboard's own Pick Rate is (Picked As Req Qty + Substitution Qty) ÷
 * Pick Hours per associate (checked 2026-09-23: 74 / 1.054 h = 70.2). The
 * day's rate is the same ratio over everyone — total units ÷ total hours —
 * not a mean of the associates' rates, which would let a 3-minute pick count
 * as much as a 2-hour one.
 *
 * `dates` (ISO) that have no rows come back as a zero day (rate null), so a
 * day with no Express Pickup is recorded rather than re-pulled forever. The
 * caller only passes them when the read as a whole returned rows.
 */
export function expressPickRates(rows, { dates = [] } = {}) {
  const days = new Map();
  for (const row of rows || []) {
    const iso = isoFromPickDate(row["Pick Date"]);
    if (!iso) continue;
    if (!days.has(iso)) days.set(iso, new Map());
    const people = days.get(iso);
    const who = String(row["Associate ID"] || row.Associate || "").trim();
    if (!who) continue;
    if (!people.has(who)) people.set(who, {});
    const measure = String(row["Measure Names"] ?? "").trim();
    const v = row["Measure Values"];
    if (!isMissing(v)) people.get(who)[measure] = toNumber(v);
  }

  const out = {};
  for (const d of dates) if (ISO_RE.test(d)) out[d] = { rate: null, units: 0, hours: 0, pickers: 0 };
  for (const [iso, people] of days) {
    let units = 0, hours = 0, pickers = 0;
    for (const m of people.values()) {
      const h = m["Pick Hours"] ?? 0;
      if (!(h > 0)) continue;
      units += (m["Picked As Req Qty"] ?? 0) + (m["Substitution Qty"] ?? 0);
      hours += h;
      pickers++;
    }
    out[iso] = {
      rate: hours > 0 ? Math.round((units / hours) * 10) / 10 : null,
      units: Math.round(units),
      hours: Math.round(hours * 100) / 100,
      pickers,
    };
  }
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

/** Per-date maps merge by date: a pulled day replaces the stored one. */
function mergeDayMap(stored, pulled) {
  const out = { ...(stored || {}), ...(pulled || {}) };
  for (const k of Object.keys(out)) if (!ISO_RE.test(k)) delete out[k];
  return Object.keys(out).length ? out : null;
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

  const express     = mergeDayMap(existing?.express, incoming?.express);
  const expressRate = mergeDayMap(existing?.expressRate, incoming?.expressRate);

  return {
    ...(existing || {}),
    ...(incoming || {}),
    rawData: [...kept, ...(incoming?.rawData || [])],
    express,
    expressRate,
    fileName:   incoming?.fileName   ?? existing?.fileName   ?? null,
    uploadDate: incoming?.uploadDate ?? existing?.uploadDate ?? null,
  };
}
