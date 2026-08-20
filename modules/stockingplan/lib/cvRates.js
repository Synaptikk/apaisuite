// modules/stockingplan/lib/cvRates.js
//
// Authoritative CaseVisibility freight rates & department groupings.
// Ported verbatim from CV's own public JS (config.js?version=2.3, calc.js?version=2.0)
// captured 2026-07-28. See tools/FINDINGS.md for provenance.
//
// Pure data + tiny pure helpers — no DOM, no chrome.*.

// Per-department cases-per-hour (legacy FPT defaults). Source: config_deptListing.
export const DEPT_CPH = {
  1: 52, 2: 48, 3: 40, 4: 90, 5: 55, 6: 48, 7: 40, 8: 50, 9: 40, 10: 51,
  11: 40, 12: 40, 13: 55, 14: 40, 15: 60, 16: 45, 17: 35, 18: 40, 19: 35,
  20: 35, 21: 60, 22: 40, 23: 60, 24: 60, 25: 50, 26: 60, 27: 60, 28: 60,
  29: 60, 30: 60, 31: 60, 32: 60, 33: 60, 34: 60, 35: 60, 36: 60, 37: 51,
  40: 55, 41: 60, 42: 51, 44: 35, 46: 43, 48: 40, 49: 60, 52: 35, 55: 50,
  56: 99, 58: 60, 67: 40, 71: 51, 72: 48, 74: 53, 77: 30, 79: 55, 80: 40,
  81: 48, 82: 35, 85: 60, 87: 51, 90: 48, 91: 50, 92: 47, 93: 40, 94: 40,
  95: 47, 96: 40, 97: 48, 98: 40,
};

// Department names. Source: config_deptListing.
export const DEPT_NAME = {
  1: "Candy & Tobacco", 2: "HBA", 3: "Stationery", 4: "Household Paper",
  5: "Media & Gaming", 6: "Cameras & Supplies", 7: "Toys", 8: "Pets",
  9: "Sporting Goods", 10: "Automotive", 11: "Hardware", 12: "Paint",
  13: "Household Chemicals", 14: "Kitchen & Dining", 15: "Health & Wellness Clinics",
  16: "Outdoor Living", 17: "Home Décor", 18: "Seasonal", 19: "Crafts",
  20: "Bath & Shower", 21: "Books & Magazines", 22: "Bedding", 23: "Men's",
  24: "Boys", 25: "Shoes", 26: "Baby & Toddler", 27: "Socks", 28: "Hosiery",
  29: "Intimates", 30: "Bras & Shapewear", 31: "Accessories",
  32: "Jewelry & Sunglasses", 33: "Girls", 34: "Women's",
  35: "Plus Size & Maternity", 36: "Outerwear & Swimwear", 37: "Auto Care Center (ACC)",
  40: "OTC", 41: "College & Pro Sports Fashion", 42: "Motor Oil", 44: "Fabric",
  46: "Beauty", 48: "Firearms", 49: "Optical", 52: "Piece Goods & Crafts",
  55: "Software", 56: "Live Plants & Garden Supplies", 58: "Wireless Services",
  67: "Celebration", 71: "Furniture & Luggage", 72: "Electronics",
  74: "Closet & Organization", 77: "Large Appliances", 79: "Infant Consumables",
  80: "Service Deli", 81: "Commercial Bread", 82: "Impulse & Checkout Mdse",
  85: "1-Hour Photo", 87: "Wireless Devices", 90: "Dairy", 91: "Frozen Foods",
  92: "Dry Grocery", 93: "Meat & Seafood", 94: "Produce", 95: "DSD Grocery",
  96: "Liquor", 97: "Meat & Deli Wall", 98: "Bakery",
};

// Fallback CPH when a dept isn't found. Source: config_defaultStockingCPH.
export const DEFAULT_CPH = 65;

// Vendor-set depts contribute ZERO stocking hours. Source: config_deptVendorSet.
export const VENDOR_SET = new Set([21]); // Books/Magazines

// Grocery + Consumables depts (roll up to "Groc/Cons" = F&C).
// Source: config_deptGroc + config_deptCons.
export const GROC_DEPTS = new Set([1, 81, 82, 90, 91, 92, 95, 96, 97, 80, 98, 93, 94]);
export const CONS_DEPTS = new Set([2, 4, 8, 13, 40, 46, 79]);

// Depts that make up the D92/95 "Cases by Aisle" view. Source: gv_locDeptNbrs.
export const AISLE_DEPTS = new Set([92, 95]);

// --- Custom stocking-floor layout ------------------------------------------
// The plan is ordered to match how the store physically stocks, NOT ascending
// dept order. Each group has a display name and an ordered list of dept numbers
// rendered as consecutive rows under a divider header. Aisles (D92/95) render
// first (handled separately in buildPlan); these groups follow. Any dept not
// listed here is appended at the bottom under an "Other" header, ascending.
export const FLOOR_LAYOUT = [
  { name: "Grocery Coolers & Freezers", depts: [90, 91, 97] },
  { name: "HBA / Pharmacy",             depts: [2, 40, 46] },
  { name: "Consumables",                depts: [4, 8, 13] },
  { name: "Stationery & Celebration",   depts: [3, 19, 67] },
  { name: "Electronics",                depts: [5, 87, 72, 6] },
  { name: "Auto / Hardware / Paint",    depts: [10, 11, 12] },
  { name: "Sporting / Toys / Seasonal", depts: [9, 7, 16, 56] },
  { name: "Home",                       depts: [14, 20, 22, 71, 75] },
  { name: "Apparel",                    depts: [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34] },
  { name: "Fresh",                      depts: [93, 94, 98] },
];

// Label used for any dept not placed in a FLOOR_LAYOUT group.
export const OTHER_GROUP_NAME = "Other Departments";

// Depts hidden from the dept rollup entirely because they're fully represented
// elsewhere. 92/95 are covered by the by-aisle breakdown.
export const HIDDEN_DEPTS = new Set([92, 95]);

// Rank a dept for the custom layout: grouped depts get their group index,
// ungrouped depts sort after all groups by dept number. Returns a comparable
// [primary, secondary] tuple.
export function layoutRank(deptNbr) {
  const n = Number(deptNbr);
  let flatIndex = 0;
  for (const group of FLOOR_LAYOUT) {
    const pos = group.depts.indexOf(n);
    if (pos !== -1) return [0, flatIndex + pos];
    flatIndex += group.depts.length;
  }
  // Ungrouped: after every grouped dept, ascending by number.
  return [1, n];
}

// The group name a dept belongs to (or OTHER_GROUP_NAME).
export function groupNameForDept(deptNbr) {
  const n = Number(deptNbr);
  for (const group of FLOOR_LAYOUT) {
    if (group.depts.includes(n)) return group.name;
  }
  return OTHER_GROUP_NAME;
}

// Shipment types eligible for the aisle plan. Source: allowedShipmentTypes.
export const ALLOWED_SHIPMENT_TYPES = new Set([
  "RDC", "HVDC", "MP", "MPDD", "F", "FDD", "MK", "MILK", "CANDY",
]);

// --- pure helpers ----------------------------------------------------------

// Is this dept Food & Consumables (Groc/Cons rollup)?
export function isFoodCons(deptNbr) {
  const n = Number(deptNbr);
  return GROC_DEPTS.has(n) || CONS_DEPTS.has(n);
}

// Resolve CPH for a dept. Optional liveCph is main_json.cph
// ([{ dept_nbr, cph }]) which, when present, wins — mirroring CV's two-tier
// lookup (calc_getStockingHoursByDept + config_getCPH).
export function cphForDept(deptNbr, liveCph) {
  const n = Number(deptNbr);
  if (Array.isArray(liveCph) && liveCph.length) {
    const hit = liveCph.find((r) => Number(r.dept_nbr) === n);
    if (hit && hit.cph) return Number(hit.cph);
  }
  return DEPT_CPH[n] ?? DEFAULT_CPH;
}

// Stocking hours for a case/inner-pack count at a dept's rate.
// Vendor-set depts return 0. Matches calc_getStockingHoursByDept.
export function stockingHours(count, deptNbr, liveCph) {
  const n = Number(deptNbr);
  if (VENDOR_SET.has(n)) return 0;
  if (!count) return 0;
  return count / cphForDept(n, liveCph);
}

// Human dept label like "D92 (Dry Grocery)".
export function deptLabel(deptNbr) {
  const n = Number(deptNbr);
  const name = DEPT_NAME[n];
  return name ? `D${n} (${name})` : `D${n}`;
}

// Format decimal hours as "H:MM" (matches CV's main_decToHHMM — exact, no rounding).
export function decToHHMM(hours) {
  if (!hours || hours <= 0) return "-";
  const totalMins = Math.round(hours * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}
