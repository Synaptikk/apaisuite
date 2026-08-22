// modules/claimsdisposition/data/schema.js
//
// Canonical record schema used throughout the dashboard. Ported verbatim
// from the donor (Trey/ClaimsDisposition/src/data/schema.js); these are
// pure constants and a tiny normalization function with no dependencies.
//
// All data (real CSV rows AND any future feeds) are normalized into this
// shape before metrics / outlier code touches them.

export const DISPOSITION_TYPES = [
  "Disposal",
  "Donation",
  "Return",
  "CVP",
  "Other",
];

// Maps raw "Store Choice" / "Recommended Action" strings (from the CSV
// and any future feeds) to one of the canonical DISPOSITION_TYPES above.
// Unknown values fall through to "Other".
export const DISPOSITION_CODE_MAP = {
  DISPOSE:           "Disposal",
  "NCLM-IWFS-DISP":  "Disposal",
  DONATE:            "Donation",
  RC:                "Return",
  "NO CLAIM SHIP":   "Return",
  "NCLM-IMKI-SHIP":  "Return",
  "NCLM-IMPS-SHIP":  "Return",
  "NCLM-IMSS-SHIP":  "Return",
  "NCLM-INWN-SHIP":  "Return",
  "NCLM-INWS-SHIP":  "Return",
  CVP:               "CVP",
  OTHER:             "Other",
  OVERSTOCK:         "Other",
  RECALL:            "Other",
  STOLEN:            "Other",
  NO:                "Other",
};

export function normalizeDisposition(rawCode) {
  if (!rawCode) return "Other";
  const upper = String(rawCode).trim().toUpperCase();
  return DISPOSITION_CODE_MAP[upper] || "Other";
}

// Canonical claim record shape. Every metric, chart, and outlier rule
// reads from objects of this shape. Keep it flat and JSON-serializable.
export const CLAIM_RECORD_FIELDS = [
  "claimId",
  "storeNumber",
  "marketNumber",
  "department",
  "itemNumber",
  "itemDescription",
  "upc",
  "userId",
  "recommendedAction", // raw string from source
  "storeChoice",       // raw string from source (the actual disposition taken)
  "dispositionType",   // normalized — one of DISPOSITION_TYPES
  "dispositionAmount", // dollar value (uses totalCost)
  "totalCost",
  "totalRetail",
  "unitCost",
  "unitRetail",
  "quantity",
  "uom",
  "timestamp",         // JS Date
  "dateIso",           // YYYY-MM-DD string for fast grouping
  "hour",              // 0–23
  "dayOfWeek",         // 0 (Sun) – 6 (Sat)
];

// List of stores the module renders filter buttons / outlier rows for.
// Empty by default so packaged builds don't ship anyone's store. Populate
// at runtime (or via a per-user config) when stores get provisioned.
export const STORE_LIST = [];

// NOTE: there is deliberately no MARKET_NUMBER constant here any more. The
// market is a property of a *pull*, not of the module: it is resolved from
// Settings > Defaults when the pull runs, stored on the pull record, and read
// back from `pull.marketNumber` by load.js and the PDF cover. The old constant
// was 120, so every analyst's report was headed "Market 120" regardless of
// which stores they had actually pulled.

// Risk flag thresholds applied to a store's composite outlier score.
// (See lib/outliers.js)
export const RISK_THRESHOLDS = {
  normal:   0,
  watch:    2,
  high:     4,
  critical: 7,
};
