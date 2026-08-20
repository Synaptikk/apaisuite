// modules/sparkscango/lib/pages_registry.js
//
// Verified Power BI page IDs + visual/query metadata for the Spark &
// Scan & Go module's four source views.
//
// STATE: page IDs are USER-SUPPLIED (verified as valid URL routes). All
// Select[].Name arrays, visual IDs, bookmark states, and body markers are
// UNRESOLVED — they require a live probe against the authenticated report.
//
// Discovery contract:
//   dev/ssg_powerbi_probe.js exports a Console-friendly snippet that,
//   when run in an authenticated Edge tab on each page, dumps a sanitized
//   JSON block containing:
//     - descriptor.Select[].Name arrays per inner result
//     - DM0 schema (S) shape per result
//     - visible page title + tab/bookmark/slicer labels
//   The output is pasted back into this registry (below the STATUS_UNRESOLVED
//   sentinel) to unblock adapter completion.
//
// See docs/SPARKSCANGO_DISCOVERY.md for the running verified-mapping log.
// See docs/SPARKSCANGO_CHECKPOINT.md for continuation instructions.

export const REPORT_ID = "76bea7ea-fd3a-41d1-afff-4660a5999c1e";
export const TENANT_ID = "3cbcc3d3-094d-4006-9849-0d11d61f484d";

// Sentinel returned by adapters when the page still needs live discovery.
// The view surfaces this as an explicit "Discovery required" state — NOT
// as empty data — so the user can distinguish "no rows" from "unmapped page".
export const STATUS_UNRESOLVED = "DISCOVERY_REQUIRED";

/**
 * @typedef {object} PageDescriptor
 * @property {string} id                  Human key ("spark_exceptions" etc.)
 * @property {string} pageId              Power BI section GUID from URL
 * @property {string} label               Display label
 * @property {"spark"|"scango"} product   Product this page serves
 * @property {"exceptions"|"audits"} kind Content kind
 * @property {string} url                 Full report URL (deep link)
 * @property {string} status              STATUS_UNRESOLVED or "verified"
 * @property {string|null} bodyMarker     Regex source that identifies this
 *                                        page's QES POST in the capture ring
 *                                        buffer (populated post-discovery)
 * @property {Record<string,string>|null} selectNames
 *   Mapping from normalized field name → Power BI Select[].Name — the
 *   decoder uses this to locate columns in DM0 rows regardless of order.
 * @property {string[]} openQuestions     Human-readable notes about what's
 *                                        still unknown for this page.
 */

const url = (pageId) =>
  `https://app.powerbi.com/groups/me/reports/${REPORT_ID}/${pageId}?ctid=${TENANT_ID}&experience=power-bi`;

/** @type {Record<string, PageDescriptor>} */
export const PAGES = {
  // The user supplied one URL for BOTH Spark and Scan&Go exceptions. Until
  // live discovery proves which product this page yields (or how it toggles
  // between them via bookmarks/slicers), both entries point to the same
  // pageId. Adapters return STATUS_UNRESOLVED until the ambiguity is
  // resolved.
  scango_exceptions: {
    id: "scango_exceptions",
    pageId: "2db2baaa0eb0237b624e",
    label: "Scan & Go Exceptions",
    product: "scango",
    kind: "exceptions",
    url: url("2db2baaa0eb0237b624e"),
    status: STATUS_UNRESOLVED,
    bodyMarker: null,
    selectNames: null,
    openQuestions: [
      "Same URL supplied for Spark and Scan&Go exceptions. Live probe must determine whether a slicer/bookmark toggles between products, or whether one is missing.",
      "Select[].Name for exception ID, event timestamp, store/market/region, transaction/receipt, register, shopper ID, source status/type.",
      "Whether the page enforces a Window.Count cap (as recognition does at 500 nationwide).",
    ],
  },

  spark_exceptions: {
    id: "spark_exceptions",
    pageId: "2db2baaa0eb0237b624e",
    label: "Spark Exceptions",
    product: "spark",
    kind: "exceptions",
    url: url("2db2baaa0eb0237b624e"),
    status: STATUS_UNRESOLVED,
    bodyMarker: null,
    selectNames: null,
    openQuestions: [
      "Same URL supplied for Spark and Scan&Go exceptions — resolve as above.",
      "Select[].Name for exception ID, event timestamp, store/market/region, order ID, trip ID, driver ID, driver name, source status/type.",
    ],
  },

  scango_audits: {
    id: "scango_audits",
    pageId: "2ea55998cda7f3171c77",
    label: "Scan & Go Audits & Metrics",
    product: "scango",
    kind: "audits",
    url: url("2ea55998cda7f3171c77"),
    status: STATUS_UNRESOLVED,
    bodyMarker: null,
    selectNames: null,
    openQuestions: [
      "Verify page title/label matches Scan & Go audit content (user asked to trust observed report labels if reversed).",
      "Measure Select[].Name for Triggered / Conducted / Passed / Failed / %Failed / %Bypassed / Second Scan / Bypassed.",
      "Which time / store / market / region / BU dimensions are exposed.",
    ],
  },

  spark_audits: {
    id: "spark_audits",
    pageId: "c9aa938e6bffd9b83dfe",
    label: "Spark Audits & Metrics",
    product: "spark",
    kind: "audits",
    url: url("c9aa938e6bffd9b83dfe"),
    status: STATUS_UNRESOLVED,
    bodyMarker: null,
    selectNames: null,
    openQuestions: [
      "Verify page title/label matches Spark audit content (user asked to trust observed report labels if reversed).",
      "Measure Select[].Name for Triggered / Conducted / Passed / Failed / %Failed / %Bypassed / Spark No Feedback.",
      "Whether Spark audit rows carry driver identifiers usable for cross-linking to Dispatcher trips.",
    ],
  },
};

export function isPageResolved(pageKey) {
  return PAGES[pageKey]?.status !== STATUS_UNRESOLVED;
}

export function listUnresolved() {
  return Object.values(PAGES).filter((p) => p.status === STATUS_UNRESOLVED);
}
