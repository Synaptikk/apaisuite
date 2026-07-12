// modules/assocpurchases/lib/appriss_purchases.js
//
// APPRISS "markdown purchase discount card" search.
//
// Searches the same APPRISS Secure API used by AurorBuddy but with the
// markdown-specific search path. Returns all non-food discount-card
// purchases for the given store, aggregated per cardholder.
//
// Field names in the response are unknown until first run. The first
// response logs row0 keys to the SW console; update the cell() calls
// in parseRow() once you see the actual field names.

const SEARCH_URL = "https://wmtus.apprissretailcloud.com/platform/cpf/searchlite/getsearchresults";

const HEADERS = {
  "content-type":      "application/json;charset=UTF-8",
  "x-requested-with":  "XMLHttpRequest",
  "accept":            "application/json, text/plain, */*",
  "referer":           "https://wmtus.apprissretailcloud.com/platform/explorer",
};

const SEARCH_PATH  = "/public/quick lookup/markdown purchases/markdown purchase discount card.search";
const BUILDER_PATH = "/system/ebr/ardm/store/builder/ardm.builder";

// Report codes 8, 6, 9 = non-food general merchandise.
// Mirrors item_ext_ReportCode=8,6,9 from the user's saved Explorer link.
const NONFOOD_CODES = "8,6,9";

const BASE_BODY = {
  searchVirtualFilePath: SEARCH_PATH,
  builderVirtualFilePath: "",
  presentationType: "grid",
  startIndex: 0,
  sortColumn: "",
  pageSize: 2000,
  sortOrder: "none",
  disableDrill: false,
  filter: "",
  forceRun: false,
  showFullLoader: false,
  conditionsToSkip: [],
  preventRunningWhenNonRequiredParameterisedConditionsHaveMissingValues: true,
  canOfferRerun: true,
};

// APPRISS cell values may be raw scalars or { rawValue, cellValue } objects.
function cell(row, ...fields) {
  for (const f of fields) {
    const c = row?.[f];
    if (c == null) continue;
    const v = (typeof c === "object") ? (c.rawValue ?? c.cellValue ?? "") : c;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

// Probe: returns true if the current session can reach APPRISS as JSON.
// Used by ensureApprissAuth in service.js before making the real data fetch.
export async function probeApprissAuth() {
  try {
    const r = await fetch(SEARCH_URL, {
      method:      "POST",
      credentials: "include",
      headers:     HEADERS,
      body: JSON.stringify({
        ...BASE_BODY,
        parameters: { builderPath: BUILDER_PATH, searchPath: SEARCH_PATH },
        rowData: {},
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (r.status === 429) return true; // rate-limited = authenticated
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    return ct.includes("json") || ct.includes("text/plain");
  } catch {
    return false;
  }
}

let _rowKeysLogged = false;

// Returns array of { cardToken, cardholderName, firstName, lastName, totalAmount, txnCount, storeNo, _raw }.
// Field names are best-effort; check SW console "row0 keys" on first run and update as needed.
export async function fetchMarkdownPurchases(storeNo, { signal } = {}) {
  const body = {
    ...BASE_BODY,
    parameters: {
      searchPath:                  SEARCH_PATH,
      builderPath:                 BUILDER_PATH,
      storeno:                     String(storeNo),
      item_ext_ReportCode:         NONFOOD_CODES,
      UniqueCountofTransactionID:  "0",
    },
    rowData: {},
  };

  const ctrl    = new AbortController();
  const timer   = setTimeout(() => ctrl.abort(), 90_000);
  const merged  = (signal && typeof AbortSignal.any === "function")
    ? AbortSignal.any([ctrl.signal, signal])
    : ctrl.signal;

  let data;
  try {
    const r = await fetch(SEARCH_URL, {
      method:      "POST",
      credentials: "include",
      headers:     HEADERS,
      body:        JSON.stringify(body),
      signal:      merged,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("text/html")) throw new Error("APPRISS auth required — open wmtus.apprissretailcloud.com and sign in");
      throw new Error(`APPRISS HTTP ${r.status}`);
    }
    data = await r.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }

  // APPRISS wraps results: { success, data: { rows, totalRows, ... } }
  // Mirrors the extraction AurorBuddy's postJson does at appriss_http.js:205.
  if (!data?.success) {
    throw new Error(`APPRISS success=false: ${JSON.stringify(Object.keys(data ?? {}).slice(0, 5))}`);
  }
  const inner = data.data ?? {};
  const rows = inner.rows ?? [];
  if (!_rowKeysLogged && rows.length) {
    _rowKeysLogged = true;
    console.log("[assocpurchases] APPRISS row0 keys:", Object.keys(rows[0] ?? {}));
    console.log("[assocpurchases] APPRISS row0 sample:", rows[0]);
  }
  if (!rows.length) console.log("[assocpurchases] APPRISS returned 0 rows for store", storeNo, "(totalRows:", inner.totalRows, ")");

  return rows.map(r => ({
    cardToken:      cell(r, "transactiondiscount_cardtoken", "tender_accountnumber", "cardtoken"),
    cardholderName: cell(r, "transactiondiscount_cardholdername", "tender_cardholdername", "cardholdername"),
    firstName:      cell(r, "transactiondiscount_cardholdernamefirst", "firstname", "first_name"),
    lastName:       cell(r, "transactiondiscount_cardholdernameistt",  "lastname",  "last_name"),
    totalAmount:    cell(r, "Sum_ticketamount", "sum_ticketamount", "totalamount"),
    txnCount:       cell(r, "UniqueCountofTransactionID", "txncount", "count"),
    storeNo:        cell(r, "storeno"),
    _raw: r,
  }));
}
