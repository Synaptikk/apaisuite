// modules/digitalmetrics/lib/tests/metrics.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/metrics.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate, benchmarks, analyse, lateStartMinutes, distinctDates, filterByDate, withDates,
} from "../data/metrics.js";

const row = (over = {}) => ({
  Associate: "A", "Pick Date": "12/01/25", "Pick Hours": 8, "Pick Rate": 100,
  "FTP Expected": 100, "FTP Actual": 90,
  "Picked As Req Qty": 100, "Nil Pick Qty": 5, "Substitution Qty": 10,
  "Exception Qty Req to Pick": 0, "Exception Picked As Req Qty": 0,
  "Exception Nil Pick Qty": 0, "Exception Substitution Qty": 0,
  ...over,
});

test("headline rates are computed as percentages to one decimal", () => {
  const [a] = aggregate([row()]);
  assert.equal(a.ftpr, 90);       // 90/100
  assert.equal(a.nil_rate, 5);    // 5/100
  assert.equal(a.sub_rate, 10);   // 10/100
  assert.equal(a.hours, 8);
});

test("exception work is added into the headline metrics, not kept separate", () => {
  const [a] = aggregate([row({
    "FTP Expected": 100, "FTP Actual": 80,
    "Exception Qty Req to Pick": 100, "Exception Picked As Req Qty": 100,
  })]);
  // (80 + 100) / (100 + 100)
  assert.equal(a.ftpr, 90);
  assert.equal(a.regular_picks, 100);
  assert.equal(a.exception_picks, 100);
});

test("an associate is an exceptions picker at 20% exception work", () => {
  const at20 = aggregate([row({ "FTP Expected": 80, "Exception Qty Req to Pick": 20 })])[0];
  const at19 = aggregate([row({ "FTP Expected": 81, "Exception Qty Req to Pick": 19 })])[0];
  assert.equal(at20.isExceptionsPicker, true);
  assert.equal(at19.isExceptionsPicker, false);
});

test("pick rate is the unweighted mean of daily rates, not picks over hours", () => {
  const [a] = aggregate([
    row({ "Pick Rate": 100, "Pick Hours": 8 }),
    row({ "Pick Rate": 50,  "Pick Hours": 1 }),   // short day counts equally
  ]);
  assert.equal(a.pick_rate, 75);
});

test("missing and non-numeric cells count as zero rather than NaN", () => {
  const [a] = aggregate([{ Associate: "A" }]);
  assert.equal(a.ftpr, 0);
  assert.equal(a.hours, 0);
  assert.equal(a.pick_rate, 0);
  assert.ok(!Number.isNaN(a.nil_rate));
});

test("rows with no associate name are skipped", () => {
  assert.equal(aggregate([row({ Associate: "" }), row()]).length, 1);
});

// ── late starts ──────────────────────────────────────────────────────────
test("5:00-5:50 counts as a late 5am start; 5:51+ reads as an early 6am start", () => {
  assert.equal(lateStartMinutes("5:00 AM"), 0);
  assert.equal(lateStartMinutes("5:12 AM"), 12);
  assert.equal(lateStartMinutes("5:50 AM"), 50);
  assert.equal(lateStartMinutes("5:51 AM"), null);
  assert.equal(lateStartMinutes("5:30 PM"), null);
  assert.equal(lateStartMinutes("6:00 AM"), null);
  assert.equal(lateStartMinutes(undefined), null);
});

test("late-start minutes accumulate per associate", () => {
  const [a] = aggregate([
    row({ "Min. First Scan": "5:10 AM" }),
    row({ "Min. First Scan": "5:20 AM" }),
    row({ "Min. First Scan": "7:00 AM" }),   // not a 5am start
  ]);
  assert.equal(a.is5amAssociate, true);
  assert.equal(a.lateStartDays, 2);
  assert.equal(a.totalLateMinutes, 30);
  assert.equal(a.avgLateMinutes, 15);
});

// ── benchmarks ───────────────────────────────────────────────────────────
test("exception pickers are benchmarked only against each other", () => {
  const list = aggregate([
    row({ Associate: "REG", "FTP Expected": 100, "FTP Actual": 90 }),
    row({ Associate: "EXC", "FTP Expected": 0, "FTP Actual": 0,
          "Exception Qty Req to Pick": 100, "Exception Picked As Req Qty": 50 }),
  ]);
  const b = benchmarks(list);
  assert.equal(b.ftpr, 90, "regular benchmark must exclude the exception picker");
  assert.equal(b.exc_ftpr, 50);
});

test("every regular picker counts toward the pick-rate benchmark", () => {
  // Fashion used to be filtered out here. The category was retired 2026-08-25
  // (data/classify.js) and nothing sets it any more, so the exclusion was
  // reading a value that never appears — the benchmark now includes everyone
  // who is not an exceptions picker.
  const list = aggregate([
    row({ Associate: "DIG", "Pick Rate": 100 }),
    row({ Associate: "OTH", "Pick Rate": 20 }),
  ]);
  const b = benchmarks(list, {});
  assert.equal(b.pick_rate, 60, "the mean of 100 and 20");
  assert.equal(b.ftpr, 90);
});

test("benchmarks ignore a classifications map it no longer consults", () => {
  const list = aggregate([
    row({ Associate: "DIG", "Pick Rate": 100 }),
    row({ Associate: "OTH", "Pick Rate": 20 }),
  ]);
  // A legacy stored "Fashion" must not resurrect the old filtering.
  assert.equal(benchmarks(list, { OTH: "Fashion" }).pick_rate, 60);
});

test("benchmarks over an empty list are zero, not NaN", () => {
  const b = benchmarks([]);
  for (const v of Object.values(b)) assert.equal(v, 0);
});

// ── dates ────────────────────────────────────────────────────────────────
test("distinct dates are local YYYY-MM-DD and forward-filled", () => {
  assert.deepEqual(
    distinctDates([{ "Pick Date": "12/01/25" }, {}, { "Pick Date": "12/02/25" }]),
    ["2025-12-01", "2025-12-02"],
  );
});

test("date filtering is inclusive at both ends", () => {
  const rows = withDates([
    { Associate: "A", "Pick Date": "12/01/25" },
    { Associate: "A", "Pick Date": "12/02/25" },
    { Associate: "A", "Pick Date": "12/03/25" },
  ]);
  const kept = filterByDate(rows, {
    start: new Date(2025, 11, 2), end: new Date(2025, 11, 3),
  });
  assert.equal(kept.length, 2);
});

test("analyse ties the layers together", () => {
  const out = analyse([row(), row({ Associate: "B" })], {});
  assert.equal(out.associates.length, 2);
  assert.equal(out.benchmarks.ftpr, 90);
  assert.deepEqual(out.dates, ["2025-12-01"]);
});
