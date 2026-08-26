// modules/digitalmetrics/lib/tests/wmweek.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { wmWeek, fiscalYearStart, weekLabel, weeksInFiscalYear } from "../data/wmweek.js";

// ── the two anchors this was pinned against ───────────────────────────────

test("2026-08-22 is WK 30, per Tableau's WM_WEEK and the scheduler", () => {
  // Tableau's WM_WEEK filter reports 202630 for this week; the Workforce
  // Planning scheduler shows "WK 30". Both must agree with us.
  const w = wmWeek("2026-08-22");
  assert.equal(w.week, 30);
  assert.equal(w.year, 2026);
  assert.equal(w.code, "202630");
  assert.equal(w.label, "WK 30");
});

test("the fiscal year starts on the Saturday of the week containing 1 Feb", () => {
  // 2026-02-01 is a Sunday, so week 1 starts the day before.
  assert.equal(fiscalYearStart(2026).toDateString(), "Sat Jan 31 2026");
});

test("week 1 is the week containing 1 February", () => {
  assert.equal(wmWeek("2026-01-31").week, 1);
  assert.equal(wmWeek("2026-02-01").week, 1, "1 Feb itself is in week 1");
  assert.equal(wmWeek("2026-02-07").week, 2);
});

// ── adjacent weeks ────────────────────────────────────────────────────────

test("consecutive Saturdays are consecutive weeks", () => {
  assert.equal(wmWeek("2026-08-15").week, 29);
  assert.equal(wmWeek("2026-08-22").week, 30);
  assert.equal(wmWeek("2026-08-29").week, 31);
});

test("any day maps to the week its Saturday starts", () => {
  // Sat-Fri weeks: everything from the 22nd to the 28th is WK 30.
  for (const d of ["2026-08-22", "2026-08-25", "2026-08-28"]) {
    assert.equal(wmWeek(d).week, 30, d);
  }
  assert.equal(wmWeek("2026-08-29").week, 31, "Saturday starts the next week");
});

// ── year boundary ─────────────────────────────────────────────────────────

test("January before the fiscal start belongs to the PREVIOUS fiscal year", () => {
  // A naive "use the calendar year" would call this week 1 of 2026.
  const w = wmWeek("2026-01-10");
  assert.equal(w.year, 2025);
  assert.ok(w.week >= 49, `expected a late week, got ${w.week}`);
});

test("a fiscal year has 52 or 53 weeks", () => {
  for (const y of [2024, 2025, 2026, 2027]) {
    const n = weeksInFiscalYear(y);
    assert.ok(n === 52 || n === 53, `FY${y} had ${n}`);
  }
});

test("the last week of one year is followed by week 1 of the next", () => {
  const start = fiscalYearStart(2027);
  const prev = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
  assert.equal(wmWeek(start).week, 1);
  assert.equal(wmWeek(prev).year, 2026);
  assert.equal(wmWeek(prev).week, weeksInFiscalYear(2026));
});

// ── labels ────────────────────────────────────────────────────────────────

test("the picker label carries the week number AND its dates", () => {
  // The number alone does not say which days you are looking at.
  const label = weekLabel("2026-08-22");
  assert.match(label, /^WK 30 · /);
  assert.match(label, /22/);
  assert.match(label, /28/);
});

test("the fiscal year can be shown when it matters", () => {
  assert.match(weekLabel("2026-08-22", { withYear: true }), /WK 30 \(FY26\)/);
});

// ── robustness ────────────────────────────────────────────────────────────

test("junk yields null rather than a wrong week", () => {
  assert.equal(wmWeek("not-a-date"), null);
  assert.equal(wmWeek(""), null);
  assert.equal(wmWeek(null), null);
});

test("a bad value falls back to showing itself, not 'WK NaN'", () => {
  assert.equal(weekLabel("nonsense"), "nonsense");
});

test("parsing is LOCAL, so a week key never slips a day", () => {
  // new Date("2026-08-22") is UTC midnight — the 21st in any negative-offset
  // zone, which would land this in WK 29.
  assert.equal(wmWeek("2026-08-22").weekStart, "2026-08-22");
});
