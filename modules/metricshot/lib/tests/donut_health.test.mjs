// modules/metricshot/lib/tests/donut_health.test.mjs
//
// Run with: node --test modules/metricshot/lib/tests/donut_health.test.mjs
//
// Fixtures are the verbatim exports recorded in
// docs/vizpick-headline-data-findings.md, including the two details that break
// naive parsers: the trailing space in "New VizPick ", and Tableau emitting
// each donut as a row PAIR where the background arc row has blank percentages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapDonutHealth, mapDepartmentGroups } from "../sources/parse_vizpick_export.js";

// "VizPick Donut Health" — note the trailing space on "New VizPick ".
const HEALTH_ROWS = [
  ["Cases Seen %", "New Location %", "New Overstock %", "New Pick %", "New VizPick ", "New VizPick Remaining"],
  ["", "", "", "", "98", "2.072630895"],          // background arc — percentages blank
  ["93%", "98%", "91%", "87%", "98", ""],         // the real value row
];

const DEPT_ROWS = [
  ["Department Group", "Cases Seen %", "New Location %", "New Overstock %", "New Pick %", "New VizPick ", "New VizPick Remaining"],
  ["Fresh", "", "", "", "", "95", "4.741211888"],
  ["Fresh", "89%", "97%", "95%", "83%", "95", ""],
  ["F&C", "", "", "", "", "100", "0"],
  ["F&C", "96%", "97%", "88%", "91%", "100", ""],
  ["GM", "", "", "", "", "94", "5.5"],
  ["GM", "90%", "99%", "88%", "80%", "94", ""],
];

test("headline: maps every ring off the value row", () => {
  const { health, metrics } = mapDonutHealth(HEALTH_ROWS);
  assert.equal(health, 98, "composite comes from 'New VizPick ' despite the trailing space");
  assert.deepEqual(metrics, [
    { label: "Cases",     value: 93, goal: 95 },
    { label: "Locations", value: 98, goal: 95 },
    { label: "Picks",     value: 87, goal: 90 },
    { label: "Overstock", value: 91, goal: 90 },
  ]);
});

test("headline: skips the background arc row rather than reading it as data", () => {
  // Taking rows[1] would give four nulls and a card of em dashes that looks
  // like a capture failure rather than a parse bug.
  const { metrics } = mapDonutHealth(HEALTH_ROWS);
  assert.ok(metrics.every((m) => Number.isFinite(m.value)), "no ring should be blank");
});

test("headline: 'New VizPick Remaining' is never mistaken for the score", () => {
  const rows = HEALTH_ROWS.map((r) => r.slice());
  rows[2][5] = "42";                       // populate Remaining on the value row
  assert.equal(mapDonutHealth(rows).health, 98, "still the score, not the remainder");
});

test("headline: survives column reordering", () => {
  const order = [4, 0, 5, 3, 1, 2];        // arbitrary shuffle
  const rows = HEALTH_ROWS.map((r) => order.map((i) => r[i]));
  const { health, metrics } = mapDonutHealth(rows);
  assert.equal(health, 98);
  assert.equal(metrics.find((m) => m.label === "Picks").value, 87);
});

test("departments: returns Fresh / F&C / GM with their own scores", () => {
  assert.deepEqual(mapDepartmentGroups(DEPT_ROWS), [
    { label: "Fresh", value: 95 },
    { label: "F&C",   value: 100 },
    { label: "GM",    value: 94 },
  ]);
});

test("departments: one entry per group, not one per arc row", () => {
  // Six data rows, three groups. Counting rows instead of groups would render
  // three phantom rings.
  assert.equal(mapDepartmentGroups(DEPT_ROWS).length, 3);
});

test("departments: no numeric department column is required or used", () => {
  const headers = DEPT_ROWS[0].join(" ").toLowerCase();
  assert.ok(!headers.includes("dept"),
    "the export is pre-aggregated; a department-number mapping must never be inferred");
});

test("both mappers degrade to empty rather than throwing", () => {
  for (const bad of [null, undefined, [], [["only a header"]]]) {
    assert.deepEqual(mapDonutHealth(bad), { health: null, metrics: [] });
    assert.deepEqual(mapDepartmentGroups(bad), []);
  }
});
