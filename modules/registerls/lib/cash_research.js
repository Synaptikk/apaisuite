// modules/registerls/lib/cash_research.js
//
// APPRISS Explorer "Cash Research Search" — the 10-day cash ledger for one
// register: readings, expected cash, finalized long/short, cash advances,
// pickups and till check-in/out counts per trading day. This is the
// supporting search WorkView itself links from every long/short item.
// Wire shape in dev/REGISTER_LS_FINDINGS.md §1.
//
// Goes through AurorBuddy's APPRISS HTTP client (retries, auth-wall
// detection, async-job polling) rather than a second copy of it.

import { postJson } from "../../aurorbuddy/lib/appriss_http.js";
import { APPRISS_BASE, APPRISS_HOME } from "../../../shared/appriss.js";

export const SEARCH_PATH  = "/public/work items/supporting searches/cash research search.search";
export const BUILDER_PATH = "/system/ebr/overshort/builder/overshort.builder";

export const EXPLORER_URL = (storeNbr, registerNbr, days = 10) =>
  `${APPRISS_BASE}/platform/explorer#/results?searchPath=${encodeURIComponent(SEARCH_PATH)}` +
  `&dailyreconciliation_storeno=${storeNbr}&dailyreconciliation_posno=${registerNbr}` +
  `&dailyreconciliation_tradingday,dailyreconciliation_tradingday1=${days},day&builderPath=${encodeURIComponent(BUILDER_PATH)}`;

export function buildCashResearchBody(storeNbr, registerNbr, days = 10) {
  return {
    searchVirtualFilePath: SEARCH_PATH,
    builderVirtualFilePath: "",
    presentationType: "grid",
    startIndex: 0, sortColumn: "", pageSize: 0, sortOrder: "none",
    disableDrill: false, filter: "", forceRun: false, showFullLoader: false,
    conditionsToSkip: [],
    preventRunningWhenNonRequiredParameterisedConditionsHaveMissingValues: true,
    parameters: {
      searchPath: SEARCH_PATH,
      dailyreconciliation_storeno: String(storeNbr),
      dailyreconciliation_posno:   String(registerNbr),
      dailyreconciliation_tradingday:  String(days),
      dailyreconciliation_tradingday1: "day",
      builderPath: BUILDER_PATH,
    },
    rowData: {}, canOfferRerun: true,
  };
}

// Column ids → our field names. Header display names are kept beside them
// so a renamed column can be spotted from the decoded `columns` list.
const COLS = {
  dailyreconciliation_tradingday:        ["date",             "date"],
  dailyreconciliation_storeno:           ["store",            "text"],
  dailyreconciliation_posno:             ["register",         "text"],
  displayField:                          ["readingCents",     "money"],
  displayField_1:                        ["expectedCashCents","money"],
  displayField_2:                        ["readingEbtCents",  "money"],
  displayField_3:                        ["readingCheckCents","money"],
  displayField_4:                        ["mfgCouponCents",   "money"],
  sumofCashLongShortAmount:              ["cashLsCents",      "money"],
  dailyreconciliation_overshortamount:   ["finalizedLsCents", "money"],
  sumofPaymentAmount:                    ["advancesCents",    "money"],
  sumofPaymentAmount_1:                  ["pickupsCents",     "money"],
  uniqueCountofTransactionType_1:        ["tillCheckouts",    "int"],
  uniqueCountofTransactionType:          ["tillCheckins",     "int"],
};

export function cellMoneyToCents(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s) return 0;
  const neg = s.startsWith("-") || s.endsWith("-") || /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[-()]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) * (neg ? -1 : 1) : 0;
}

function cellDate(cell) {
  const raw = String(cell?.rawValue || "");
  let m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = String(cell?.cellValue || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// Pure. `data` is the `data` object of the getsearchresults payload.
export function decodeLedger(data) {
  const headers = data?.headers || {};
  const columns = Object.entries(headers).map(([id, h]) => ({ id, label: h?.cellValue || id, known: !!COLS[id] }));
  const rows = (data?.rows || []).map((row) => {
    const out = {};
    for (const [id, [field, kind]] of Object.entries(COLS)) {
      const cell = row[id];
      if (kind === "date")       out[field] = cellDate(cell);
      else if (kind === "money") out[field] = cellMoneyToCents(cell?.rawValue ?? cell?.cellValue);
      else if (kind === "int")   out[field] = parseInt(String(cell?.rawValue ?? cell?.cellValue ?? "0").replace(/[^\d-]/g, ""), 10) || 0;
      else                       out[field] = String(cell?.rawValue ?? cell?.cellValue ?? "").trim();
    }
    return out;
  }).filter((r) => r.date).sort((a, b) => b.date.localeCompare(a.date));
  return { rows, columns };
}

// Service-worker side. Returns { ok, rows, columns, fetchedAt } or an
// error envelope the view can act on.
export async function fetchCashLedger(storeNbr, registerNbr, { days = 10, signal } = {}) {
  const body = buildCashResearchBody(storeNbr, registerNbr, days);
  const data = await postJson(body, { label: `cash-research ${storeNbr}/${registerNbr}`, signal });
  if (!data) {
    return { ok: false, errorClass: "AUTH_OR_HTTP", error: "Cash Research Search failed — APPRISS session expired or the search errored. Sign in to Secure and retry.", loginUrl: APPRISS_HOME };
  }
  const decoded = decodeLedger(data);
  return { ok: true, ...decoded, days, fetchedAt: new Date().toISOString(), explorerUrl: EXPLORER_URL(storeNbr, registerNbr, days) };
}
