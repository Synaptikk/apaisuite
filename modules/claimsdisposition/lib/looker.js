// modules/claimsdisposition/lib/looker.js
//
// Pure helpers for talking to the Claims Disposition Looker Studio embed.
// Everything in this file is data — no chrome.* calls, no DOM, no I/O.
// The service-worker handler in service.js calls these to build the request
// body and decode the response, then issues the actual POST via
// chrome.scripting.executeScript (running inside the open embed tab) so the
// browser attaches the right cookies + same-origin Referer.
//
// Provenance: the request shape was captured live on 2026-05-28 from the
// real Looker `batchedDataV2` POST that the embed fires when the user enters
// a store number. See claims_disposition_reference.md for the wider context.

// ── Stable identifiers extracted from the captured request ─────────────
// These come from the Looker report definition itself. If Walmart re-publishes
// the report (new reportId), or Looker renames an internal field, the request
// will start returning errors and these constants will need refreshing.
// To re-capture: open the embed, change the STORE filter, copy the request
// body of the resulting batchedDataV2 POST from DevTools Network.
export const REPORT_ID     = "4d607b7f-15b3-488a-b7a3-c426c7dc5b37";
export const PAGE_ID       = "38997673";
export const DATASOURCE_ID = "70a16f75-2dc0-436c-9fd0-07c3a7f5394b";
export const COMPONENT_ID  = "cd-s9yhtr2r2c";                  // table chart id
export const STORE_FIELD_QT_NAME = "qt_xv1huq2r2c";            // internal alias for _STORE_
export const DATE_FIELD_QT_NAME  = "qt_69ce7r2r2c";            // internal alias for _Create_Date_

// The `batchedDataV2` endpoint includes a versioned `appVersion` query param.
// The captured value is treated as a default — the live embed's version may
// shift week-to-week. The SW reads the actual version off the open embed
// tab's main script tag when it can; if that fails it falls back here.
export const DEFAULT_APP_VERSION = "20260526_0400";

// ── Column registry — single source of truth ───────────────────────────
// Each entry maps a CSV column header to the Looker internal qt_ alias and
// the BigQuery source field. The order of this array is exactly the order
// the SW will write columns in the generated CSV.
//
// `kind` matches the JSON column shape in the response (stringColumn,
// longColumn, doubleColumn, dateColumn). Verified live in recon: 7 of 10
// target stores returned 16-column rows with these exact types.
//
// `aggregation` mirrors the captured request — for the 6-aggregation fields
// (QTY, Total Cost, Total Retail) Looker requires aggregation=6 (SUM); for
// the per-row Unit Cost / Unit Retail aggregation=0 (NONE).
export const COLUMNS = [
  { csv: "Department",         qtName: "qt_yxkhfv2r2c", source: "_Department_Name_",  kind: "stringColumn" },
  { csv: "Item #",             qtName: "qt_37sbhv2r2c", source: "calc_0r3vxhr8zd",    kind: "stringColumn" }, // calculated field — renders as hyperlinked item number in the UI
  { csv: "Item Desc",          qtName: "qt_0pgbjv2r2c", source: "_ITEM_DESC_",        kind: "stringColumn" },
  { csv: "UPC #",              qtName: "qt_5zsrkv2r2c", source: "_UPC_Nbr_",          kind: "longColumn"   },
  { csv: "Userid",             qtName: "qt_u7c3lv2r2c", source: "_Userid_",           kind: "stringColumn" },
  { csv: "Best Outcome",       qtName: "qt_hh7hnv2r2c", source: "_Best_Outcome_",     kind: "stringColumn" },
  { csv: "Recommended Action", qtName: "qt_h5guov2r2c", source: "_Recommended_Action_", kind: "stringColumn" },
  { csv: "Store Choice",       qtName: "qt_g2obqv2r2c", source: "_Store_Choice_",     kind: "stringColumn" },
  { csv: "Create Date",        qtName: "qt_lpbefx2r2c", source: "_Create_Date_",      kind: "dateColumn"   },
  { csv: "Create Time",        qtName: "qt_s6kjjx2r2c", source: "_Create_Time_",      kind: "stringColumn" },
  { csv: "Unit Cost",          qtName: "qt_n2tgsw2r2c", source: "_Unit_Cost_Amt_",    kind: "doubleColumn", aggregation: 0 },
  { csv: "Unit Retail",        qtName: "qt_imnxuw2r2c", source: "_Unit_Retail_Amt_",  kind: "doubleColumn", aggregation: 0 },
  { csv: "UOM",                qtName: "qt_q2rdtv2r2c", source: "_UOM_",              kind: "stringColumn" },
  { csv: "QTY",                qtName: "qt_o4nuj5qs2c", source: "_QTY_",              kind: "longColumn",   aggregation: 6 },
  { csv: "Total Cost",         qtName: "qt_ojeqow2r2c", source: "_Total_Cost_Amt_",   kind: "doubleColumn", aggregation: 6 },
  { csv: "Total Retail",       qtName: "qt_nc0jiw2r2c", source: "_Total_Retail_Amt_", kind: "doubleColumn", aggregation: 6 },
];

// Convert a Date / "YYYY-MM-DD" / "YYYYMMDD" into the int form Looker expects
// (YYYYMMDD as a number — NOT a string). Throws on garbage input.
export function toLookerDateInt(d) {
  if (typeof d === "number" && d >= 19700101 && d <= 99991231) return d;
  let s;
  if (d instanceof Date) {
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    s = `${y}${String(m).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  } else if (typeof d === "string") {
    s = d.replace(/-/g, "");
  } else {
    throw new TypeError(`toLookerDateInt: unsupported input ${typeof d}`);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || s.length !== 8) {
    throw new RangeError(`toLookerDateInt: cannot parse "${d}" as YYYYMMDD`);
  }
  return n;
}

// Build the batchedDataV2 POST body for one store + one date range. The
// store filter is on the _STORE_ field. The date range uses a SINGLE context
// (c0) — the live embed splits into c0/c1 to support the "include today"
// toggle in the date picker, but for our purposes one continuous range is
// simpler and returns identical row data.
//
// IMPORTANT: store IDs in the underlying dataset have NO leading zeros, even
// though the embed's free-text input visually accepts "0669" / "00669" and
// the reference docs describe a 4-digit format. Verified live 2026-05-28:
// `EQ 669` returns 23,589 rows for the last 30 days; `EQ 0669` and `EQ 00669`
// both return 0. The UI input must be normalizing on submit. We strip leading
// zeros here so callers can pass either "0669" or "669" and get the right
// result.
export function buildPayload({ store, startDate, endDate }) {
  const storeStr = String(store).replace(/^0+/, "") || "0";
  const startInt = toLookerDateInt(startDate);
  const endInt   = toLookerDateInt(endDate);

  const queryFields = COLUMNS.map((c) => {
    const field = { name: c.qtName, datasetNs: "d0", tableNs: "t0",
                    dataTransformation: { sourceFieldName: c.source } };
    if (c.aggregation !== undefined) field.dataTransformation.aggregation = c.aggregation;
    return field;
  });

  return {
    dataRequest: [{
      requestContext: {
        reportContext: {
          reportId: REPORT_ID,
          pageId: PAGE_ID,
          mode: 1,
          componentId: COMPONENT_ID,
          displayType: "simple-table",
          actionId: "crossFilters|reportDefault",
        },
        requestMode: 0,
      },
      datasetSpec: {
        dataset: [{ datasourceId: DATASOURCE_ID, revisionNumber: 0, parameterOverrides: [] }],
        queryFields,
        sortData: [
          { sortColumn: { name: "qt_lpbefx2r2c", datasetNs: "d0", tableNs: "t0",
                          dataTransformation: { sourceFieldName: "_Create_Date_" } }, sortDir: 1 },
          { sortColumn: { name: "qt_s6kjjx2r2c", datasetNs: "d0", tableNs: "t0",
                          dataTransformation: { sourceFieldName: "_Create_Time_" } }, sortDir: 1 },
        ],
        includeRowsCount: true,
        relatedDimensionMask: { addDisplay: false, addUniqueId: false, addLatLong: false },
        // 50k cap matches what the live embed sends. Per-store row counts in
        // recon topped out around 23k for 30 days, so this is comfortable.
        // If a future longer-range pull (90d+) approaches 50k, the SW will
        // need to paginate by walking startRow.
        paginateInfo: { startRow: 1, rowsCount: 50000 },
        dsFilterOverrides: [],
        filters: [{
          filterDefinition: {
            filterExpression: {
              include: true, conceptType: 0,
              concept: { name: STORE_FIELD_QT_NAME, ns: "t0" },
              filterConditionType: "EQ",
              queryTimeTransformation: { dataTransformation: { sourceFieldName: "_STORE_" } },
              stringValues: [storeStr],
            },
          },
          dataSubsetNs: { datasetNs: "d0", tableNs: "t0", contextNs: "c0" },
          version: 3, isCanvasFilter: true,
        }],
        features: [],
        dateRanges: [{
          startDate: startInt, endDate: endInt,
          dataSubsetNs: { datasetNs: "d0", tableNs: "t0", contextNs: "c0" },
        }],
        contextNsCount: 1,
        dateRangeDimensions: [{
          name: DATE_FIELD_QT_NAME, datasetNs: "d0", tableNs: "t0",
          dataTransformation: { sourceFieldName: "_Create_Date_" },
        }],
        calculatedField: [],
        needGeocoding: false, geoFieldMask: [], multipleGeocodeFields: [],
        timezone: "America/New_York",
      },
      role: "main",
      retryHints: { useClientControlledRetry: true, isLastRetry: false, retryCount: 0,
                    originalRequestId: `apaisuite-claimsdisposition-${storeStr}-${Date.now()}` },
    }],
  };
}

// Google prefixes JSON responses with `)]}'` as an anti-JSON-hijack guard.
// Strip it before JSON.parse. (See https://google.github.io/styleguide/jsoncstyleguide.xml.)
export function parseLookerJson(rawText) {
  const cleaned = rawText.replace(/^\)\]\}'\s*/, "");
  return JSON.parse(cleaned);
}

// Walk the Looker response and emit an array of plain-object rows keyed by
// CSV column name. Each Looker column object holds a per-type values array
// (stringColumn / longColumn / doubleColumn / dateColumn) of the same length.
// We zip them by index into row objects matching COLUMNS order.
//
// The `warning` field on the return is populated for any non-fatal anomaly
// (column-count mismatch, empty response despite totalCount > 0) so the
// caller can surface it to the UI — silent zero-row returns make root cause
// impossible to debug from the user side.
export function decodeRows(responseJson) {
  const ds = responseJson?.dataResponse?.[0]?.dataSubset?.[0]?.dataset?.tableDataset;
  if (!ds) return { rows: [], totalCount: 0, warning: "no tableDataset in response" };

  const totalCount = ds.totalCount ?? 0;
  const cols = ds.column ?? [];
  if (!cols.length) {
    return {
      rows: [], totalCount,
      warning: totalCount > 0 ? `totalCount=${totalCount} but column array empty — possible schema drift` : null,
    };
  }

  let warning = null;
  if (cols.length !== COLUMNS.length) {
    warning = `response column count ${cols.length} != expected ${COLUMNS.length} — schema likely drifted in the Looker report; CSV may be missing or padded columns`;
    console.warn(`[claimsdisposition] ${warning}`);
  }

  // For each EXPECTED column index, pull whichever per-type values array is
  // populated. If the response has fewer columns than expected, the missing
  // indices fall through to an empty array.
  const valuesPerCol = COLUMNS.map((wantCol, i) => {
    const c = cols[i];
    if (!c) return [];
    const v = c[wantCol.kind]?.values
              ?? c.stringColumn?.values
              ?? c.longColumn?.values
              ?? c.doubleColumn?.values
              ?? c.dateColumn?.values
              ?? [];
    if (wantCol.kind === "dateColumn") return v.map(normalizeLookerDate);
    return v;
  });

  // Row count = the max length across our extracted columns (not just col[0],
  // which could be the missing one in a partial-schema response).
  const rowCount = valuesPerCol.reduce((m, arr) => Math.max(m, arr.length), 0);
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    const row = {};
    for (let c = 0; c < COLUMNS.length; c++) {
      row[COLUMNS[c].csv] = valuesPerCol[c]?.[r] ?? "";
    }
    rows.push(row);
  }
  return { rows, totalCount, warning };
}

function normalizeLookerDate(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  // YYYYMMDD → YYYY-MM-DD. Already-ISO strings pass through unchanged.
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

// Compute the (startDate, endDate) for "last N days, including today" in the
// embed's reporting timezone (America/New_York). Returns YYYYMMDD ints.
export function lastNDaysRange(n, { now = new Date() } = {}) {
  // Use UTC-day arithmetic anchored to NY-day. The Looker request sends ints
  // (not full timestamps), so DST transitions don't matter — we just need
  // "today in NY" and "today minus N-1 days in NY".
  const nyToday = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const end = new Date(nyToday.getFullYear(), nyToday.getMonth(), nyToday.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - (n - 1));
  return { startDate: toLookerDateInt(start), endDate: toLookerDateInt(end) };
}

// The Looker embed URL the SW tab needs to be on (or be opened to) before
// it can fire same-origin POSTs against batchedDataV2.
export const EMBED_URL = `https://datastudio.google.com/embed/reporting/${REPORT_ID}/page/tEnnC`;
