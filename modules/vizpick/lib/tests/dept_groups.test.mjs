// modules/vizpick/lib/tests/dept_groups.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/dept_groups.test.mjs
//
// The fixture is the real "Department Groups Donuts Health" export, captured
// live from store 1 on 2026-08-22. Two things about it are easy to get wrong:
// the sheet emits TWO rows per group (score on one, components on the other),
// and Tableau's score header carries a trailing space.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDepartmentGroups } from "../parse_vizpick_stores_csv.js";

const T = "\t";
const row = (...c) => c.join(T);

// Verbatim, including the trailing space in "New VizPick ".
const REAL = [
  row("Department Group", "Cases Seen %", "New Location %", "New Overstock %", "New Pick %", "New VizPick ", "New VizPick Remaining"),
  row("Fresh", "", "", "", "", "66", "34.308400693"),
  row("Fresh", "25%", "48%", "95%", "91%", "66", ""),
  row("F&C", "", "", "", "", "28", "71.595941579"),
  row("F&C", "16%", "16%", "95%", "0%", "28", ""),
  row("GM", "", "", "", "", "20", "79.859922134"),
  row("GM", "0%", "1%", "91%", "0%", "20", ""),
].join("\r\n");

test("merges the split rows into one group each", () => {
  const r = parseDepartmentGroups(REAL);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.groups.map((g) => g.label), ["Fresh", "F&C", "GM"]);
  assert.deepEqual(r.groups.map((g) => g.value), [66, 28, 20]);
});

test("keeps the component percentages from the row that carries them", () => {
  const { groups } = parseDepartmentGroups(REAL);
  const fresh = groups.find((g) => g.label === "Fresh");
  assert.deepEqual(fresh, {
    label: "Fresh", value: 66,
    casesSeenPct: 25, locationPct: 48, overstockPct: 95, pickPct: 91,
  });
});

test("a real 0% is preserved, not treated as missing", () => {
  // GM's Pick % is genuinely 0. Writing blank-as-zero, or zero-as-blank, makes
  // "no picks done" and "no data" render identically — the failure this file
  // keeps having to guard against.
  const gm = parseDepartmentGroups(REAL).groups.find((g) => g.label === "GM");
  assert.equal(gm.pickPct, 0);
  assert.equal(gm.casesSeenPct, 0);
  assert.equal(gm.locationPct, 1);
});

test("the trailing space in Tableau's score header does not break the lookup", () => {
  const trimmed = REAL.replace("New VizPick \t", "New VizPick\t");
  const r = parseDepartmentGroups(trimmed);
  assert.equal(r.ok, true);
  assert.deepEqual(r.groups.map((g) => g.value), [66, 28, 20]);
});

test("these are NOT what the local proxy computes — that is the point", () => {
  // metricshot's computeDeptGroupRings() derives Fresh/F&C/GM from the
  // department breakout using only Cases % and Pick %, because the breakout
  // carries nothing else per department. Tableau weights those two at 70% of
  // the score. Measured on this same store at this same moment the proxy gave
  // 57.9 / 8.2 / 0.05 against the 66 / 28 / 20 below. The gap is why this
  // sheet is captured rather than derived.
  const { groups } = parseDepartmentGroups(REAL);
  const gm = groups.find((g) => g.label === "GM");
  // With Cases 0% and Picks 0%, any two-metric mean is ~0 — yet Tableau says
  // 20, because Overstock (91%) and Location (1%) carry 30% of the weight.
  assert.equal(gm.casesSeenPct, 0);
  assert.equal(gm.pickPct, 0);
  assert.equal(gm.value, 20);
});

test("a sheet without the score column is rejected by name", () => {
  const wrong = [row("Dept", "Suggested Picks Seen"), row("1", "5")].join("\r\n");
  const r = parseDepartmentGroups(wrong);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing column\(s\)/);
  assert.match(r.reason, /Department Group/);
});

test("rows with no score are dropped rather than emitted as null wheels", () => {
  const partial = [
    row("Department Group", "New VizPick "),
    row("Fresh", "66"),
    row("Ghost", ""),
  ].join("\r\n");
  const { groups } = parseDepartmentGroups(partial);
  assert.deepEqual(groups.map((g) => g.label), ["Fresh"]);
});

test("empty and malformed input fails cleanly", () => {
  for (const bad of ["", null, undefined, "Department Group"]) {
    assert.equal(parseDepartmentGroups(bad).ok, false);
  }
});
