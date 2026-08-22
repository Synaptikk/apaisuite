// modules/claimsdisposition/lib/load.js
//
// Converts a raw pull (16 CSV-header-keyed rows per store, as produced by
// looker.js::decodeRows and stored in IndexedDB by service.js::pull) into
// the canonical claim-record shape every chart/metric/outlier component
// consumes. The baked-in CSV demo loader was removed when the dashboard
// moved to live-pulls-only as its sole data source.
//
// The canonical record shape lives in data/schema.js::CLAIM_RECORD_FIELDS;
// the actual field-mapping (raw → canonical) is `rowToRecord` below.

import { normalizeDisposition } from "../data/schema.js";
import { toIsoDate } from "./dates.js";

/**
 * Materialize canonical records from one pull's stored row data.
 *
 * @param {object} pull - pull record from db.getLatestPull / getPullById.
 *   Required shape: { storesByNumber: { [storeNumberStr]: rawRow[] } }.
 *   Each rawRow has CSV-header keys ("Department", "Item #", "Item Desc",
 *   "UPC #", "Userid", "Best Outcome", "Recommended Action", "Store Choice",
 *   "Create Date", "Create Time", "Unit Cost", "Unit Retail", "UOM", "QTY",
 *   "Total Cost", "Total Retail").
 * @returns {{ records: object[], realStoreNumbers: number[], totalRows: number }}
 */
export function loadDatasetFromPull(pull) {
  if (!pull?.storesByNumber) {
    return { records: [], realStoreNumbers: [], totalRows: 0 };
  }
  const realStoreNumbers = Object.keys(pull.storesByNumber)
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);

  // The market travels on the pull record (written by service.js::pull from
  // Settings > Defaults). Pulls taken before that field existed have none, so
  // their records carry null rather than an inherited "120".
  const marketNumber = pull.marketNumber ?? null;

  const out = [];
  for (const storeNumber of realStoreNumbers) {
    const rows = pull.storesByNumber[String(storeNumber)] ?? [];
    for (let i = 0; i < rows.length; i++) {
      const rec = rowToRecord(rows[i], { storeNumber, marketNumber, index: i });
      if (rec) out.push(rec);
    }
  }
  return { records: out, realStoreNumbers, totalRows: out.length };
}

// ── CSV row → canonical record adapter ──────────────────────────
//
// Source columns (live pull OR exported CSV — same shape):
//   Department, Item #, Item Desc, UPC #, Userid, Best Outcome,
//   Recommended Action, Store Choice, Create Date, Create Time,
//   Unit Cost, Unit Retail, UOM, QTY, Total Cost, Total Retail
//
// Exported so any future loader (e.g. Firebase delta-sync) can reuse it
// without duplicating the field-mapping logic.
export function rowToRecord(row, { storeNumber, marketNumber, index }) {
  const timestamp = parseDateTime(row["Create Date"], row["Create Time"]);
  if (!timestamp) return null;

  const storeChoice        = (row["Store Choice"] || "").trim();
  const recommendedAction  = (row["Recommended Action"] || "").trim();
  const dispositionType    = normalizeDisposition(storeChoice || recommendedAction);

  const totalCost   = toNumber(row["Total Cost"]);
  const totalRetail = toNumber(row["Total Retail"]);
  const quantity    = toNumber(row["QTY"]) || 1;

  return {
    claimId: `S${storeNumber}-${index}`,
    storeNumber,
    marketNumber,
    department:       cleanDept(row["Department"]),
    itemNumber:       row["Item #"] || "",
    itemDescription:  row["Item Desc"] || "",
    upc:              row["UPC #"] || "",
    userId:           row["Userid"] || "",
    recommendedAction,
    storeChoice,
    dispositionType,
    dispositionAmount: totalCost,
    totalCost,
    totalRetail,
    unitCost:    toNumber(row["Unit Cost"]),
    unitRetail:  toNumber(row["Unit Retail"]),
    quantity,
    uom:         row["UOM"] || "EA",
    timestamp,
    dateIso:     toIsoDate(timestamp),
    hour:        timestamp.getHours(),
    dayOfWeek:   timestamp.getDay(),
  };
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function cleanDept(raw) {
  if (!raw) return "Unknown";
  const s = String(raw).trim();
  const m = s.match(/^(\d+)\s*-\s*(.+)$/);
  return m ? `${m[1].padStart(2, "0")} - ${m[2].trim()}` : s;
}

// Live-pull Create Date arrives as "2026-05-27" (normalized by
// looker.js::normalizeLookerDate). Create Time arrives as "12:59:25 PM"
// from Looker. The donor's original CSV had "May 27, 2026" / "12:59:25 PM"
// — that format still parses fine via native Date too. Handle both for
// resilience.
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const d = String(dateStr).trim();
  const t = String(timeStr || "12:00:00 PM").trim();
  const parsed = new Date(`${d} ${t}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
