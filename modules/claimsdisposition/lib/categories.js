// modules/claimsdisposition/lib/categories.js
//
// Store categories (Food & Consumables, Fresh, GM) and the department →
// category map, both taken from Ops Portal so the dashboard's split matches
// what the store sees on hoops.wal-mart.com/ops-portal/metrics/cvp.
//
// Source: tRPC `utils.dept.sbuIdDepts` (columns sbu, sbuId, deptGroup,
// acctgDeptNbr, acctgDeptDesc, isFreshDeptInd), read 2026-10-18. The CVP
// page's three tiles query:
//   Fresh               depts [80,81,93,94,97,98]  (isFreshDeptInd = 1)
//   Food & Consumables  sbuIds [1,4]               (Food + Consumables SBUs)
//   GM                  sbuIds [3]                 (Hardlines + ETS)
//
// Ops Portal's F&C tile INCLUDES the six Fresh depts. Here the three are kept
// separate (F&C = SBUs 1+4 minus Fresh), so F&C + Fresh = Ops Portal's F&C.
// Depts 83/84 sit in Food's "Fresh" dept group but carry no fresh flag, and
// Ops Portal's Fresh tile leaves them out, so they stay in F&C here too.
// Style (Home/Fashion/Beauty), Health & Wellness, Fuel and the unassigned
// depts are on no tile; they land in "Other" so the totals still reconcile.

export const CATEGORIES = [
  { id: "fc",    label: "Food & Consumables", short: "F&C"   },
  { id: "fresh", label: "Fresh",              short: "Fresh" },
  { id: "gm",    label: "General Merchandise", short: "GM"   },
  { id: "other", label: "Other",              short: "Other" },
];

const FRESH_DEPTS = [80, 81, 93, 94, 97, 98];
const FOOD_CONSUMABLES_DEPTS = [
  // Consumables (SBU 4)
  2, 4, 8, 13, 40, 79,
  // Food (SBU 1): Chilled Alcohol & Convenience, non-flagged Fresh, Pantry
  1, 82, 90, 91, 96, 83, 84, 92, 95,
];
const GM_DEPTS = [
  // Hardlines
  3, 9, 10, 11, 12, 16, 19, 37, 56,
  // Entertainment, Toys & Seasonal
  5, 6, 7, 18, 21, 58, 67, 72, 77, 85, 87,
];

// The dept lists each category sends to Ops Portal's CVP endpoint. Sending
// depts (not sbuIds) keeps F&C exclusive of Fresh, matching the claims split.
export const OPS_PORTAL_DEPTS = {
  fc:    FOOD_CONSUMABLES_DEPTS,
  fresh: FRESH_DEPTS,
  gm:    GM_DEPTS,
};

const DEPT_TO_CATEGORY = new Map([
  ...FRESH_DEPTS.map((d) => [d, "fresh"]),
  ...FOOD_CONSUMABLES_DEPTS.map((d) => [d, "fc"]),
  ...GM_DEPTS.map((d) => [d, "gm"]),
]);

/**
 * Category id for a claim's department. Accepts the record's "NN - NAME"
 * string (load.js::cleanDept) or a bare number.
 */
export function categoryOfDept(department) {
  const n = typeof department === "number"
    ? department
    : Number.parseInt(String(department ?? "").trim(), 10);
  return DEPT_TO_CATEGORY.get(n) ?? "other";
}

export function categoryLabel(id) {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}
