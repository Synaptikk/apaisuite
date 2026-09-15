// modules/digitalmetrics/lib/sources/tableau_express.js
//
// Express Pickup orders and units for ONE store on ONE day, from the Store
// Fulfillment Scorecard's "Metric Overview and Hourly" dashboard. Runs in the
// service worker.
//
// Why one day per page load: the dashboard has no date dimension in any
// worksheet — its "Overview" sheet is a single aggregate over whatever the
// Report Date slider (field RPT_DT) spans. Setting RPT_DT to a single ISO date
// in the URL pins the slider to that day, so a daily series costs one tab per
// day. Measured 2026-09-15 (store 1458): 9/13 = 54 orders / 1,197 units,
// 9/14 = 33 / 589, and 9/13,9/14 together = 87 / 1,786 — the sum, so the
// per-day reads are exact.
//
// The filters are a THREE-STEP CASCADE ("Select WM Week First", "Select
// Market Second", then "Store"), and the Overview sheet returns nothing until
// all three are set — the hourly sheets tolerate a missing market, the
// Overview does not. WM_WEEK must be the fiscal week that CONTAINS the date
// (202633 for 2026-09-14); a date outside the selected week returns 0 rows.

import { readWorksheetViaTab } from "./tableau_driver.js";
import { parseOverview } from "../data/express.js";
import { wmWeek } from "../../../../shared/wmweek.js";

const VIEW_BASE =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/MetricOverviewandHourly";

// Field names, not captions ("Select WM Week First" is WM_WEEK, "Store" is
// STORE, "Fulfillment Type" is FULFMT_TYPE, the Report Date slider is RPT_DT).
export const FULFILLMENT_TYPE = "Express Pickup";
const WORKSHEET = "Overview";

const enc = encodeURIComponent;

/**
 * The view URL scoped to one store, one fiscal week, one day, and (by default)
 * Express Pickup only. `fulfillmentType: null` leaves the type unfiltered —
 * the whole store-day — which is how a quiet day is told apart from a broken
 * one (see pullExpressDay).
 */
export function buildExpressUrl(store, market, isoDate, { fulfillmentType = FULFILLMENT_TYPE } = {}) {
  if (!store)  throw new Error("buildExpressUrl: no store");
  if (!market) throw new Error("buildExpressUrl: no market");
  const wk = wmWeek(isoDate);
  if (!wk) throw new Error(`buildExpressUrl: bad date ${isoDate}`);
  const qs =
    `WM_WEEK=${enc(wk.code)}` +
    `&MARKET=${enc(String(market))}` +
    `&STORE=${enc(String(store))}` +
    (fulfillmentType ? `&FULFMT_TYPE=${enc(fulfillmentType)}` : "") +
    `&RPT_DT=${enc(isoDate)}`;
  return `${VIEW_BASE}?:iid=1&:linktarget=_self&${qs}`;
}

/**
 * One store-day. Returns `{ date, orders, units, sales, pulledAt }`.
 *
 * An EMPTY Overview is ambiguous. A day with no Express Pickup orders at all
 * returns no rows under the type filter (store 1458, Sunday 2026-09-07: 0
 * rows filtered, 1,043 orders unfiltered) — and so does an unscoped view
 * (wrong market, week/date mismatch, SSO wall). The two are told apart by
 * reloading WITHOUT the type filter: rows there mean a real quiet day and
 * the day is recorded as zeros; none there means the view is broken and the
 * day fails. The second load only happens on empty days, which are rare.
 */
export async function pullExpressDay(store, market, isoDate, { onProgress = () => {} } = {}) {
  const extra = { store, date: isoDate, source: "express" };
  const { rows } = await readWorksheetViaTab(buildExpressUrl(store, market, isoDate), WORKSHEET, { onProgress, extra });
  if (rows.length) {
    return { date: isoDate, ...parseOverview(rows, { store }), pulledAt: new Date().toISOString() };
  }

  const check = await readWorksheetViaTab(
    buildExpressUrl(store, market, isoDate, { fulfillmentType: null }), WORKSHEET, { onProgress, extra });
  if (!check.rows.length) {
    throw new Error(
      `the Metric Overview returned no rows for store ${store} on ${isoDate} ` +
      `(market ${market}). Check the store's market.`);
  }
  // The store had a day; it just had no Express Pickup in it.
  return { date: isoDate, orders: 0, units: 0, sales: 0, pulledAt: new Date().toISOString() };
}
