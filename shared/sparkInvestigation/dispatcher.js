// shared/sparkInvestigation/dispatcher.js
//
// Dispatcher API (swift.walmart.com) queries. Both SparkFraud and Spark &
// Scan&Go call these from the service worker.
//
// Extracted from modules/sparkfraud/service.js:_fetchDispatcherTrips
// (line 1380-1403) verbatim, but centered-window and services list are
// now parameters so different consumers can widen/narrow the query without
// forking the helper.

import { SWIFT_DASHBOARD_URL } from "./endpoints.js";

const DEFAULT_SERVICES = ["PICKING", "PICKING_DELIVERY", "DELIVERY"];

/**
 * Fetch dispatcher trips for a store within a symmetric time window around
 * a center moment (defaults to now — matches the SparkFraud watchlist poll).
 *
 * @param {object} opts
 * @param {object} opts.headers          Dispatcher auth headers (from
 *                                       auth.buildSwiftHeaders).
 * @param {string|number} opts.store     Store number.
 * @param {number} [opts.windowMinutes]  Half-width in minutes (default 120).
 * @param {Date|number} [opts.center]    Center moment (default: now).
 * @param {string[]} [opts.services]     Trip services filter.
 * @param {number} [opts.pageSize]       (Default 200.)
 * @returns {Promise<object[]>}          Trip records; empty on empty result.
 * @throws  Error on non-2xx HTTP; caller decides retry/reauth.
 */
export async function fetchDispatcherTrips({
  headers,
  store,
  windowMinutes = 120,
  center,
  services = DEFAULT_SERVICES,
  pageSize = 200,
} = {}) {
  const now = center instanceof Date ? center : (typeof center === "number" ? new Date(center) : new Date());
  const start = new Date(now.getTime() - windowMinutes * 60_000);
  const end   = new Date(now.getTime() + windowMinutes * 60_000);
  const body = {
    startTime: start.toISOString(),
    endTime:   end.toISOString(),
    pickupPointIds: [String(store)],
    clients: ["0"],
    pageSize,
    services,
  };
  const r = await fetch(SWIFT_DASHBOARD_URL, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error(`Dispatcher HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  return data?.payload?.tasksByClientId?.["0"]?.trips || [];
}
