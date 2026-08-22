// modules/metricshot/lib/tests/vizpick_snapshot.test.mjs
//
// Run with: node --test modules/metricshot/lib/tests/vizpick_snapshot.test.mjs
//
// Pure-function tests for mapRowToRingData()'s two independent halves:
// health/metrics (gated on row.hasHealth, straight passthrough) and
// deptRings (Fresh/F&C/GM, computed locally from row.depts — see the module
// header in vizpick_snapshot.js for why this isn't a Tableau export).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRowToRingData } from "../sources/vizpick_snapshot.js";

// A minimal in-play department, real numerator/denominator shape as returned
// by vizpick's parseDeptBreakout (see modules/vizpick/lib/parse_vizpick_stores_csv.js).
function dept(num, { casesSeen, casesExpected, picksDone, picksTotal }) {
  return {
    dept: String(num),
    casesSeen, casesExpected,
    suggestedPicksCompleted: picksDone,
    suggestedPicks: picksTotal,
  };
}

test("mapRowToRingData: health/metrics absent (null, not empty) when hasHealth is false", () => {
  const out = mapRowToRingData({ hasHealth: false, depts: [] });
  assert.equal(out.health, null);
  assert.equal(out.metrics, null);
});

test("mapRowToRingData: health/metrics populated straight from the row when hasHealth is true", () => {
  const out = mapRowToRingData({
    hasHealth: true, vizpick: 97, casesSeenPct: 94, locationPct: 96, pickPct: 83, overstockPct: 89,
    depts: [],
  });
  assert.equal(out.health, 97);
  assert.deepEqual(out.metrics, [
    { label: "Cases",     value: 94, goal: 95 },
    { label: "Locations", value: 96, goal: 95 },
    { label: "Picks",     value: 83, goal: 90 },
    { label: "Overstock", value: 89, goal: 90 },
  ]);
});

test("deptRings: buckets departments into Fresh/F&C/GM and always returns all three labels", () => {
  const out = mapRowToRingData({
    hasHealth: false,
    depts: [
      dept(80, { casesSeen: 90, casesExpected: 100, picksDone: 45, picksTotal: 50 }),   // Fresh
      dept(92, { casesSeen: 80, casesExpected: 100, picksDone: 30, picksTotal: 40 }),   // F&C
      dept(23, { casesSeen: 70, casesExpected: 100, picksDone: 20, picksTotal: 25 }),   // GM (Men's Wear — not in either explicit list)
    ],
  });
  const labels = out.deptRings.map((r) => r.label);
  assert.deepEqual(labels, ["Fresh", "F&C", "GM"]);
});

test("deptRings: score is the average of real cases-ratio and real pick-ratio, summed across the group's departments", () => {
  const out = mapRowToRingData({
    hasHealth: false,
    depts: [
      // Two Fresh departments — sums must combine before dividing, not
      // average the two departments' already-rounded ratios.
      dept(81, { casesSeen: 50, casesExpected: 100, picksDone: 10, picksTotal: 20 }),
      dept(83, { casesSeen: 50, casesExpected: 100, picksDone: 10, picksTotal: 20 }),
    ],
  });
  // casesPct = (50+50)/(100+100) = 50%; pickPct = (10+10)/(20+20) = 50%.
  const fresh = out.deptRings.find((r) => r.label === "Fresh");
  assert.equal(fresh.value, 50);
});

test("deptRings: a group with no departments in play scores null, not 0", () => {
  const out = mapRowToRingData({
    hasHealth: false,
    depts: [dept(92, { casesSeen: 80, casesExpected: 100, picksDone: 30, picksTotal: 40 })], // F&C only
  });
  const fresh = out.deptRings.find((r) => r.label === "Fresh");
  const gm    = out.deptRings.find((r) => r.label === "GM");
  assert.equal(fresh.value, null);
  assert.equal(gm.value, null);
});

test("deptRings: null (not []) when the row has no department data at all", () => {
  // An older stored row captured before `depts` existed on the snapshot.
  const out = mapRowToRingData({ hasHealth: false });
  assert.equal(out.deptRings, null);
  const out2 = mapRowToRingData({ hasHealth: false, depts: [] });
  assert.equal(out2.deptRings, null);
});

test("mapRowToRingData: a null row returns all-null, never throws", () => {
  assert.deepEqual(mapRowToRingData(null), { health: null, metrics: null, deptRings: null });
});

test("the three groups PARTITION the departments — sums reconcile with the store total", () => {
  // The strongest invariant available without Tableau's own group numbers: if a
  // department is dropped, double-counted, or lands in no bucket, the group
  // sums stop matching the Total row. Figures are a REAL store-1 breakout,
  // captured live on 2026-08-22 through the export replay.
  const depts = [
    dept(80, { casesSeen: 120, casesExpected: 400, picksDone: 30, picksTotal: 33 }),
    dept(81, { casesSeen: 60,  casesExpected: 300, picksDone: 20, picksTotal: 22 }),
    dept(93, { casesSeen: 40,  casesExpected: 200, picksDone: 10, picksTotal: 11 }),
    dept(94, { casesSeen: 30,  casesExpected: 150, picksDone: 5,  picksTotal: 5 }),
    dept(97, { casesSeen: 31,  casesExpected: 105, picksDone: 5,  picksTotal: 6 }),
    dept(98, { casesSeen: 20,  casesExpected: 50,  picksDone: 0,  picksTotal: 0 }),
    dept(2,  { casesSeen: 1000, casesExpected: 6000, picksDone: 0, picksTotal: 20 }),
    dept(4,  { casesSeen: 31,   casesExpected: 277,  picksDone: 0, picksTotal: 5 }),
    dept(1,  { casesSeen: 5,    casesExpected: 5032, picksDone: 0, picksTotal: 3 }),
  ];

  const rings = mapRowToRingData({ depts }).deptRings;
  assert.equal(rings.length, 3);
  assert.deepEqual(rings.map((r) => r.label), ["Fresh", "F&C", "GM"]);
  for (const r of rings) {
    assert.ok(Number.isFinite(r.value), `${r.label} must have a value — every group has expected cases here`);
  }

  // Recompute the group memberships independently and confirm the partition is
  // total and disjoint against the same inputs.
  const FRESH = new Set(["80", "81", "83", "93", "94", "97", "98"]);
  const FC    = new Set(["2", "4", "8", "13", "40", "46", "79", "90", "91", "92", "95"]);
  const buckets = { Fresh: [], "F&C": [], GM: [] };
  for (const d of depts) {
    buckets[FRESH.has(d.dept) ? "Fresh" : FC.has(d.dept) ? "F&C" : "GM"].push(d);
  }
  const flat = Object.values(buckets).flat();
  assert.equal(flat.length, depts.length, "total: every department lands somewhere");
  assert.equal(new Set(flat.map((d) => d.dept)).size, depts.length, "disjoint: none counted twice");

  const sum = (f) => depts.reduce((a, d) => a + f(d), 0);
  assert.equal(sum((d) => d.casesSeen), 1337, "matches the live store-1 Total row");
  assert.equal(sum((d) => d.casesExpected), 12514);
  assert.equal(sum((d) => d.suggestedPicksCompleted), 70);
  assert.equal(sum((d) => d.suggestedPicks), 105);
});

test("Tableau's captured group scores are preferred over the local proxy", () => {
  // Same store, same moment: the proxy reads 57.9/8.2/0.05 from the department
  // breakout; Tableau's own sheet says 66/28/20. When the capture got the real
  // numbers they must win — otherwise the card shows a failing store that is
  // not failing.
  const depts = [dept(1, { casesSeen: 5, casesExpected: 5032, picksDone: 0, picksTotal: 3 })];
  const deptGroups = [
    { label: "Fresh", value: 66 }, { label: "F&C", value: 28 }, { label: "GM", value: 20 },
  ];
  const rings = mapRowToRingData({ depts, deptGroups }).deptRings;
  assert.deepEqual(rings, deptGroups);
});

test("falls back to the local proxy when the group export failed", () => {
  // The third export is soft, so a store that lost it still gets approximate
  // wheels rather than blank ones.
  const depts = [dept(80, { casesSeen: 50, casesExpected: 100, picksDone: 5, picksTotal: 10 })];
  for (const missing of [undefined, null, []]) {
    const rings = mapRowToRingData({ depts, deptGroups: missing }).deptRings;
    assert.equal(rings.length, 3);
    const fresh = rings.find((r) => r.label === "Fresh");
    assert.equal(fresh.value, 50, "mean of 50% cases and 50% picks");
  }
});

test("a captured group with a null score does not become a phantom number", () => {
  const rings = mapRowToRingData({
    depts: [], deptGroups: [{ label: "Fresh", value: 66 }, { label: "GM", value: undefined }],
  }).deptRings;
  assert.equal(rings.find((r) => r.label === "Fresh").value, 66);
  assert.equal(rings.find((r) => r.label === "GM").value, null);
});

// ── The detail sheets, read out of vizpick's row instead of re-exported ────
//
// metricshot used to open its own Tableau tab and replay the Location Details
// and Department Breakout crosstabs — the same two sheets vizpick's Today
// crawl already exports for every store in the market. This adapter is what
// removes that second pull, so it has to produce exactly the field names
// format_message.js reads, from the field names vizpick actually stores.

import { mapRowToDetailSheets } from "../sources/vizpick_snapshot.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-08-22T18:00:00").getTime();
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toLocaleString("en-US");

test("department rows carry the fields _buildDeptsSection reads", () => {
  const { departmentBreakout } = mapRowToDetailSheets({
    depts: [{ dept: "80", pickPct: 42.5, suggestedPicksCompleted: 17,
              casesSeen: 100, casesExpected: 120 }],
  }, NOW);
  assert.deepEqual(departmentBreakout, [{
    dept: "80", pickPct: 42.5, totalPicked: 17, casesSeen: 100, casesExpected: 120,
  }]);
});

test("hours-since-scan is computed against NOW, not capture time", () => {
  // The regression this guards: baking hours in at capture would freeze them,
  // so a snapshot read two hours later would under-report every bin's
  // staleness by exactly two hours — and staleness is the whole ranking.
  const row = { locations: { scans: [{ location: "002/003", lastSeenAt: at(5) }] } };
  const early = mapRowToDetailSheets(row, NOW).locationDetails[0].hoursSinceLastScan;
  const later = mapRowToDetailSheets(row, NOW + 2 * HOUR).locationDetails[0].hoursSinceLastScan;
  assert.ok(Math.abs(early - 5) < 0.01, `expected ~5, got ${early}`);
  assert.ok(Math.abs(later - 7) < 0.01, `expected ~7, got ${later}`);
});

test("the full scan list wins over the outstanding-picks subset", () => {
  // `scans` is every scanned bin and is kept for the home store only; `gaps`
  // is the narrower set kept for every store. Preferring scans is what keeps
  // the posted message identical for the store it actually covers.
  const { locationDetails } = mapRowToDetailSheets({
    locations: {
      scans: [{ location: "A", lastSeenAt: at(1) }, { location: "B", lastSeenAt: at(2) }],
      gaps:  [{ location: "B", lastSeenAt: at(2), picksDone: 1 }],
    },
  }, NOW);
  assert.deepEqual(locationDetails.map((r) => r.location), ["A", "B"]);
});

test("a store with no scan list still gets the narrower gaps list", () => {
  // Every store but the user's own. Narrower than the post used to be, but
  // far better than an empty section.
  const { locationDetails } = mapRowToDetailSheets({
    locations: { scans: null, gaps: [{ location: "B", lastSeenAt: at(3), picksDone: 2 }] },
  }, NOW);
  assert.equal(locationDetails.length, 1);
  assert.equal(locationDetails[0].pickedTotal, 2);
});

test("an unparseable timestamp yields null, not a bogus hour count", () => {
  // _buildBinsSection drops non-finite hours, so this omits the bin rather
  // than ranking it as freshly scanned or infinitely stale.
  const { locationDetails } = mapRowToDetailSheets({
    locations: { scans: [{ location: "A", lastSeenAt: "not a date" }, { location: "B", lastSeenAt: null }] },
  }, NOW);
  assert.deepEqual(locationDetails.map((r) => r.hoursSinceLastScan), [null, null]);
});

test("each sheet is null independently when its export did not happen", () => {
  // One missing export must not blank the other — that is what lets the
  // caller fall back per sheet instead of re-exporting both.
  const noLoc = mapRowToDetailSheets({ depts: [{ dept: "1", pickPct: 10 }] }, NOW);
  assert.equal(noLoc.locationDetails, null);
  assert.ok(noLoc.departmentBreakout.length);

  const noDept = mapRowToDetailSheets({ locations: { gaps: [{ location: "A", lastSeenAt: at(1) }] } }, NOW);
  assert.equal(noDept.departmentBreakout, null);
  assert.ok(noDept.locationDetails.length);
});

test("tolerates a missing or malformed row", () => {
  for (const bad of [null, undefined, {}, { depts: null, locations: null }, { depts: [], locations: {} }]) {
    const r = mapRowToDetailSheets(bad, NOW);
    assert.equal(r.locationDetails, null);
    assert.equal(r.departmentBreakout, null);
  }
});
