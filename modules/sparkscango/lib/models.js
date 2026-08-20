// modules/sparkscango/lib/models.js
//
// Normalized types for Spark & Scan & Go rows. Source-neutral; every raw
// field kept accessible via `raw` for troubleshooting.
//
// This module is runtime-inert (pure factories + normalizers). Consumers:
//   - service.js (SW)   — decodes captured QES responses into ExceptionRow[]
//                          / AuditMetric[] and hands them to the view via
//                          chrome.storage.local cache keys.
//   - view.js (page)    — reads cache, filters, renders.
//   - investigation_bridge.js — normalizes ExceptionRow → identifier bag.

/**
 * @typedef {object} ExceptionRow
 * @property {"spark"|"scango"} source
 * @property {string} sourcePage          key from lib/pages_registry.js
 * @property {string} exceptionId         stable ID from source (may be synthesized if source has none)
 * @property {string} exceptionType       e.g. "Spark No Feedback", "Second Scan"
 * @property {string|null} storeNbr
 * @property {string|null} marketNbr
 * @property {string|null} regionNbr
 * @property {string|null} buId
 * @property {number|null} eventTimestamp  ms epoch (UTC)
 * @property {string|null} eventTimezone   IANA zone, e.g. "America/New_York"
 * @property {string|null} orderId
 * @property {string|null} tripId
 * @property {string|null} transactionId
 * @property {string|null} receiptId
 * @property {string|null} registerNbr
 * @property {string|null} driverId
 * @property {string|null} driverName
 * @property {string|null} shopperId
 * @property {string|null} sourceStatus
 * @property {Record<string, number|string>} sourceMetrics
 * @property {unknown} raw                original QES cell values, keyed by verified Select[].Name
 * @property {number} fetchedAt           ms epoch (SW clock)
 * @property {number|null} sourceAsOf     Report refresh timestamp, when the QES bundle exposes one
 */

/** @typedef {object} AuditMetric
 * @property {"spark"|"scango"} source
 * @property {string} sourcePage
 * @property {string} name                e.g. "% Failed"
 * @property {string} nameDisplay         user-facing label
 * @property {number|null} value
 * @property {"count"|"percent"|"ratio"|"currency"|"other"} unit
 * @property {string|null} bucketKey      time/store/market/region if series
 * @property {string|null} bucketValue
 * @property {unknown} raw
 * @property {number} fetchedAt
 */

/**
 * Return a plain empty ExceptionRow for the given source/page, ready to be
 * partially populated by an adapter. Explicit nulls (rather than undefined)
 * make view-side handling trivial (`row.orderId ?? "—"`).
 */
export function newExceptionRow({ source, sourcePage }) {
  const now = Date.now();
  return {
    source,
    sourcePage,
    exceptionId:     "",
    exceptionType:   "",
    storeNbr:        null,
    marketNbr:       null,
    regionNbr:       null,
    buId:            null,
    eventTimestamp:  null,
    eventTimezone:   null,
    orderId:         null,
    tripId:          null,
    transactionId:   null,
    receiptId:       null,
    registerNbr:     null,
    driverId:        null,
    driverName:      null,
    shopperId:       null,
    sourceStatus:    null,
    sourceMetrics:   {},
    raw:             null,
    fetchedAt:       now,
    sourceAsOf:      null,
  };
}

export function newAuditMetric({ source, sourcePage }) {
  return {
    source,
    sourcePage,
    name:         "",
    nameDisplay:  "",
    value:        null,
    unit:         "other",
    bucketKey:    null,
    bucketValue:  null,
    raw:          null,
    fetchedAt:    Date.now(),
  };
}

/**
 * Extract the strongest available identifier bag from an exception row.
 * Used by investigation_bridge.js to pick the best lookup strategy.
 * Order matters — later fields are weaker signals.
 */
export function extractIdentifiers(row) {
  return {
    orderId:      nonBlank(row.orderId),
    tripId:       nonBlank(row.tripId),
    driverId:     nonBlank(row.driverId),
    driverName:   nonBlank(row.driverName),
    storeNbr:     nonBlank(row.storeNbr),
    eventTsMs:    Number.isFinite(row.eventTimestamp) ? row.eventTimestamp : null,
    eventTz:      nonBlank(row.eventTimezone) || "America/New_York",
    // Scan&Go specific — no Spark lookup, but useful in the source-only display
    transactionId: nonBlank(row.transactionId),
    receiptId:     nonBlank(row.receiptId),
    registerNbr:   nonBlank(row.registerNbr),
    shopperId:     nonBlank(row.shopperId),
  };
}

function nonBlank(v) {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}
