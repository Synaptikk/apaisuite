// modules/digitalmetrics/lib/sources/tableau_metrics.js
//
// Automated pull of the "Associate By Day" data from the Store Fulfillment
// Scorecard. Runs in the service worker.
//
// The contract here was established live — see
// dev/DIGITALMETRICS_PULL_FINDINGS.md, which is the file to read before
// changing any constant below.
//
// Shape of one pull:
//   1. open the view in a background tab, with the filters as URL PARAMETERS
//   2. wait for window.tableau.VizManager to register a viz (TOP frame)
//   3. getSummaryDataAsync on the "Associate By Day" worksheet
//      (steps 1–3 live in tableau_driver.js, shared with tableau_express.js)
//   4. pivot (lib/data/tableau.js) → split by store+week (lib/data/parse.js)
//
// Why URL parameters and not applyFilterAsync: the view's filters are a
// DEPENDENT CASCADE ("Select Pick Date First", "Select Store Number(s)
// Second"). Until a date is set, `Store #` has an empty domain and
// applyFilterAsync throws an error whose entire message is the rejected value.
// URL parameters are applied server-side before the view renders, so the
// cascade never has to be satisfied client-side. Measured: 3 dates for one
// store = 4,064 rows in a single page load.
//
// URL-parameter filters do NOT persist into the user's saved view state the
// way an applied categorical filter does (checked 2026-09-15: a fresh load
// after several scoped pulls opened with every control at "(None)").

import { readWorksheetViaTab } from "./tableau_driver.js";

const VIEW_BASE =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance";

// Field names, NOT the captions shown on the controls. The captions
// ("Select Pick Date First") are not accepted as URL keys.
const FILTER_DATE  = "Pick Date";
const FILTER_STORE = "Store #";
// "Fulfillment Type" on the control. Unset = every type (the metrics pull).
const FILTER_FULFMT = "FULFMT_TYPE";

// Trailing space is real — the worksheet is named "Associate By Day ". The
// driver compares trimmed.
const WORKSHEET = "Associate By Day";

/**
 * Build the scoped view URL. Dates are ISO and comma-separated.
 * `fulfillmentType` (e.g. "Express Pickup") narrows every measure to that
 * type — checked live 2026-09-23 against the view's own numbers.
 */
export function buildViewUrl(store, isoDates, { fulfillmentType = null } = {}) {
  const dates = (Array.isArray(isoDates) ? isoDates : [isoDates]).filter(Boolean);
  const qs =
    `${encodeURIComponent(FILTER_DATE)}=${dates.map(encodeURIComponent).join(",")}` +
    `&${encodeURIComponent(FILTER_STORE)}=${encodeURIComponent(store)}` +
    (fulfillmentType ? `&${FILTER_FULFMT}=${encodeURIComponent(fulfillmentType)}` : "");
  return `${VIEW_BASE}?:iid=1&:linktarget=_self&${qs}`;
}

/**
 * Pull one (store, dates) slice. Returns the RAW melted rows; pivoting and
 * splitting are the caller's job so this stays a transport concern.
 */
export async function pullMetrics(store, isoDates, { onProgress = () => {}, fulfillmentType = null, allowEmpty = false } = {}) {
  if (!store) throw new Error("pullMetrics: no store");
  const dates = (Array.isArray(isoDates) ? isoDates : [isoDates]).filter(Boolean);
  if (!dates.length) throw new Error("pullMetrics: no dates");

  const url = buildViewUrl(store, dates, { fulfillmentType });
  const { columns, rows } = await readWorksheetViaTab(url, WORKSHEET, {
    onProgress, extra: { store, dates: dates.length, ...(fulfillmentType ? { source: "express-rate" } : {}) },
  });

  if (!rows.length && !allowEmpty) {
    // Almost always an unscoped view rather than a broken read — say which.
    throw new Error(
      `the view returned 0 rows for store ${store}. Either that store has no ` +
      `data for these dates, or the filters were not applied.`);
  }

  onProgress({ phase: "done", store, rows: rows.length });
  return { ok: true, store, dates, columns, rows };
}
