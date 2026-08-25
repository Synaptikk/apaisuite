// modules/digitalmetrics/lib/tests/opportunities.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/opportunities.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkFor, analyseOpportunities, sortOpportunities, excludeOutliers,
} from "../data/opportunities.js";

const BENCH = {
  ftpr: 90, nil_rate: 5, sub_rate: 5, pick_rate: 100,
  exc_ftpr: 50, exc_nil_rate: 20, exc_sub_rate: 20, exc_pick_rate: 40,
};

const assoc = (over = {}) => ({
  name: "A", ftpr: 90, pick_rate: 100, nil_rate: 5, sub_rate: 5,
  picked_qty: 1000, isExceptionsPicker: false,
  is5amAssociate: false, avgLateMinutes: 0, totalLateMinutes: 0, lateStartDays: 0,
  ...over,
});

test("each associate is measured against their own cohort's benchmark", () => {
  assert.equal(benchmarkFor(assoc(), BENCH).ftpr, 90);
  assert.equal(benchmarkFor(assoc({ isExceptionsPicker: true }), BENCH).ftpr, 50);
});

test("an exception picker at cohort average raises no issues", () => {
  // Against the regular benchmark this associate would look badly broken.
  const [a] = analyseOpportunities(
    [assoc({ isExceptionsPicker: true, ftpr: 50, pick_rate: 40, nil_rate: 20, sub_rate: 20 })],
    BENCH,
  );
  assert.deepEqual(a.issues, []);
  assert.equal(a.score, 0);
});

test("an associate exactly at benchmark has no issues and no score", () => {
  const [a] = analyseOpportunities([assoc()], BENCH);
  assert.deepEqual(a.issues, []);
  assert.equal(a.score, 0);
});

test("below-benchmark FTPR is flagged and scored", () => {
  const [a] = analyseOpportunities([assoc({ ftpr: 80 })], BENCH);
  assert.match(a.issues[0], /^FTPR: 80% \(avg: 90%\)$/);
  assert.equal(a.score, 10);
});

test("nil and sub rates are weighted double, pick rate a tenth", () => {
  assert.equal(analyseOpportunities([assoc({ nil_rate: 10 })],   BENCH)[0].score, 10);
  assert.equal(analyseOpportunities([assoc({ sub_rate: 10 })],   BENCH)[0].score, 10);
  assert.equal(analyseOpportunities([assoc({ pick_rate: 50 })],  BENCH)[0].score, 5);
});

test("being ABOVE benchmark never adds to the score", () => {
  const [a] = analyseOpportunities([assoc({ ftpr: 99, pick_rate: 200, nil_rate: 0, sub_rate: 0 })], BENCH);
  assert.equal(a.score, 0);
  assert.deepEqual(a.issues, []);
});

test("late starts are flagged over 5 minutes but scored from the first minute", () => {
  const flagged = analyseOpportunities(
    [assoc({ is5amAssociate: true, avgLateMinutes: 12, totalLateMinutes: 60, lateStartDays: 5 })], BENCH)[0];
  assert.match(flagged.issues[0], /Late Start: avg 5:12 AM \(60 min lost over 5 days\)/);
  assert.equal(flagged.score, 6);

  const minor = analyseOpportunities(
    [assoc({ is5amAssociate: true, avgLateMinutes: 3, totalLateMinutes: 10, lateStartDays: 4 })], BENCH)[0];
  assert.deepEqual(minor.issues, [], "3 minutes is under the flag threshold");
  assert.equal(minor.score, 1, "but still ranks");
});

test("low adherence is flagged; any shortfall is scored", () => {
  const adh = { A: { adherence: 50, isLowAdherence: true, actualHours: 4, assignedHours: 8 } };
  const [a] = analyseOpportunities([assoc()], BENCH, adh);
  assert.match(a.issues[0], /Pick Adherence: 50% \(4h of 8h assigned\)/);
  assert.equal(a.score, 10);
  assert.equal(a.adherence, 50);
});

test("associates with no adherence data are not penalised", () => {
  const [a] = analyseOpportunities([assoc()], BENCH, {});
  assert.equal(a.adherence, null);
  assert.equal(a.score, 0);
});

test("score breakdown explains every point awarded", () => {
  const [a] = analyseOpportunities([assoc({ ftpr: 80, nil_rate: 10 })], BENCH);
  assert.equal(a.scoreBreakdown.length, 2);
  assert.equal(a.score, 20);
  assert.ok(a.scoreBreakdown.every((s) => /\+\d+\.\d/.test(s)));
});

// ── sorting ──────────────────────────────────────────────────────────────
test("sorts put the worst performer first", () => {
  const list = analyseOpportunities(
    [assoc({ name: "GOOD", ftpr: 95 }), assoc({ name: "BAD", ftpr: 60 })], BENCH);
  assert.equal(sortOpportunities(list, "overall")[0].name, "BAD");
  assert.equal(sortOpportunities(list, "ftpr")[0].name, "BAD");
  assert.equal(sortOpportunities(list, "nil_rate")[0].name, "GOOD");  // tie, stable
});

test("an unknown sort key falls back to overall rather than throwing", () => {
  const list = analyseOpportunities([assoc({ name: "BAD", ftpr: 10 }), assoc({ name: "OK" })], BENCH);
  assert.equal(sortOpportunities(list, "nonsense")[0].name, "BAD");
});

// ── outliers ─────────────────────────────────────────────────────────────
test("associates below 10% of average pick volume are excluded", () => {
  const { ranked, excluded } = excludeOutliers([
    assoc({ name: "FULL", picked_qty: 1000 }),
    assoc({ name: "ALSO", picked_qty: 1000 }),
    assoc({ name: "HALFDAY", picked_qty: 10 }),   // <10% of the ~670 average
  ]);
  assert.deepEqual(ranked.map((a) => a.name), ["FULL", "ALSO"]);
  assert.deepEqual(excluded.map((a) => a.name), ["HALFDAY"]);
});

test("outlier filtering on an empty list is safe", () => {
  assert.deepEqual(excludeOutliers([]), { ranked: [], excluded: [] });
});
