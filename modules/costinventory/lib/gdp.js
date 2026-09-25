// modules/costinventory/lib/gdp.js
//
// Warehouse truck invoice cost (worksheet row 8) from GDP Connect's
// "Warehouse Details" dashboard (project 20, dashboard 351), which is a
// BigQuery front-end over `ww_ap_vm.dc_warehouse_line_item*`.
//
// The store's manual process is to open the detail widget and add up the
// `Cost Amt` column down 28+ line items per department. Dataset 1727
// (`FreshCostDeptsTrailer`) is that same arithmetic already done server-side,
// grouped to invoice date x trailer x department and hard-filtered to the four
// fresh departments — so one call replaces the paging.
//
// Verified equal to the manual method: store 1458 / dept 93 / trailer 309178 /
// 2026-09-20 sums to $1,677.23 by hand across 28 rows vs $1,677.35 here (the
// detail grid rounds each line to cents; this sums full precision).
//
// ── Two hard-won details about the query API ──────────────────────────────
//
//  1. `limit` and `offset` must appear in `legacyParams` as well as in
//     `dashboardRunTimeParams`. Leaving them out of legacyParams yields a 500
//     from generate-executable-query ("Expected ... but \"N\" found") because
//     the LIMIT clause is left unsubstituted.
//  2. `Trailer_Nbr` is a STRING column and must be passed quoted ('309178').
//     Unquoted it fails with "No matching signature for operator IN for
//     argument types STRING and {INT64}". `Store_Nbr` and `Dept_Nbr` are
//     INT64 and must stay unquoted. An empty string means "no filter".

const EXECUTE_URL = "https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query";

const PROJECT_ID    = 20;
const DASHBOARD_ID  = 351;
const DATASOURCE_ID = "bq_us_gg_shrnk_prod";

// FreshCostDeptsTrailer — cost per invoice date x trailer x fresh department.
const FRESH_TRAILER_DATASET = 1727;
const FRESH_TRAILER_VIZ     = 2268;

export class GdpError extends Error {}

/**
 * Cost by department for a specific set of trailers.
 *
 * The date range is deliberately wide: a trailer that arrives on the night of
 * the 21st can carry an invoice dated the 20th (trailer 309178 did exactly
 * that), so filtering tightly on the delivery night drops real freight. The
 * trailer list — not the date — is what makes the answer exact.
 *
 * `runQuery` is supplied by service.js and runs the POST inside a
 * gdp-connect.walmart.com tab; see executeQuery below for why.
 */
export async function fetchTrailerCosts({ runQuery, storeNbr, trailers, startDate, endDate }) {
  if (!trailers?.length) return [];

  const rows = await executeQuery({
    runQuery,
    datasetId: FRESH_TRAILER_DATASET,
    visualizationId: FRESH_TRAILER_VIZ,
    params: {
      Store_Nbr:   String(storeNbr),
      Dept_Nbr:    "",
      Invoice_Nbr: "",
      Trailer_Nbr: trailers.map((t) => "'" + String(t).replace(/'/g, "") + "'").join(","),
      start_date:  startDate,
      end_date:    endDate,
      limit:       "5000",
      offset:      "0",
    },
  });

  return rows.map((r) => ({
    invoiceDate: r.INVOICE_DATE,
    trailer:     String(r.Trailer_Number),
    storeNbr:    Number(r.store_nbr),
    dept:        Number(r.DEPT_NUMBER),
    invoices:    Number(r.nbr_of_Invoices) || 0,
    quantity:    Number(r.total_quantity) || 0,
    cost:        Number(r.Total_Cost) || 0,
    freight:     Number(r.freight_charges) || 0,
    costPlusFreight: Number(r.total_cost_and_freight_charges) || 0,
  }));
}

/**
 * Low-level call. Returns rows as objects keyed by the response's column names.
 *
 * The POST is NOT issued from the service worker. Fetching this endpoint from
 * the extension origin fails two different ways: with credentials the whole
 * walmart.com cookie jar rides along and the gateway answers 431 Request
 * Header Fields Too Large, and with `credentials: "omit"` it answers 403
 * "Invalid CORS request". Run from a page on gdp-connect.walmart.com it is an
 * ordinary same-site call and simply works — so `runQuery` executes this body
 * in that tab's MAIN world (ISOLATED would be back to extension-origin CORS).
 */
export async function executeQuery({ runQuery, datasetId, visualizationId, params }) {
  if (typeof runQuery !== "function") throw new GdpError("executeQuery: runQuery is required");

  // Same object in both slots on purpose; see the note at the top of the file.
  const body = {
    datasetId,
    visualizationId,
    dashboardId: DASHBOARD_ID,
    queryExecutionRequest: {
      queryParams: {
        nextGenFilters: "",
        legacyParams: params,
        dashboardRunTimeParams: params,
        datasource: { project: DATASOURCE_ID, datasourceType: "BIGQUERY" },
        visualizationFilterDetails: "",
        nextGenSqlParams: {},
      },
      projectId: PROJECT_ID,
      datasourceType: "BIGQUERY",
      daasDatasourceId: DATASOURCE_ID,
    },
  };

  const { status, text } = await runQuery(EXECUTE_URL, JSON.stringify(body));

  if (status === 401 || status === 403) {
    throw new GdpError("GDP rejected the captured token (" + status + ") — reopen the dashboard to refresh it");
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GdpError("GDP returned non-JSON (" + status + "): " + String(text).slice(0, 160));
  }
  if (json.error) {
    throw new GdpError("GDP query failed: " + String(json.error.message ?? json.error).slice(0, 240));
  }

  const columns = (json.columns ?? []).map((c) => c.name);
  return (json.values ?? []).map((v) => Object.fromEntries(columns.map((k, i) => [k, v[i]])));
}
