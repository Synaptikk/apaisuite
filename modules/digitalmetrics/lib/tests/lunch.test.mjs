// modules/digitalmetrics/lib/tests/lunch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shiftBounds, isWithinShift, lunchWindow, lunchSlots, lunchIssue, lunchIssues,
  lunchSummary, LUNCH_REQUIRED_AFTER_HOURS, LUNCH_EDGE_MARGIN,
} from "../data/lunch.js";

// The thresholds are the standalone app's, not invented here.
test("thresholds match the web app's suggestion engine", () => {
  assert.equal(LUNCH_REQUIRED_AFTER_HOURS, 6);
  assert.equal(LUNCH_EDGE_MARGIN, 2);
});

const assoc = (over = {}) => ({ name: "ADA", shiftStart: 0, shiftEnd: 9, slots: {}, ...over });

// ── shift bounds ──────────────────────────────────────────────────────────

test("bounds come from the schedule", () => {
  assert.deepEqual(shiftBounds(assoc()), { start: 0, end: 9, hours: 9 });
});

test("a row with no shift window has no bounds", () => {
  assert.equal(shiftBounds(assoc({ shiftStart: null, shiftEnd: null })), null);
  assert.equal(shiftBounds(assoc({ shiftEnd: 0 })), null, "end before start is not a shift");
});

test("cells inside the shift are assignable, outside are not", () => {
  const a = assoc({ shiftStart: 2, shiftEnd: 6 });
  assert.equal(isWithinShift(a, 2), true, "start is inclusive");
  assert.equal(isWithinShift(a, 5), true);
  assert.equal(isWithinShift(a, 6), false, "end is exclusive");
  assert.equal(isWithinShift(a, 1), false);
});

test("an associate with no shift window stays assignable", () => {
  // Added by hand, or a schedule that never imported. Refusing every cell
  // would make them unassignable, which is worse than allowing it.
  assert.equal(isWithinShift(assoc({ shiftStart: null, shiftEnd: null }), 5), true);
});

// ── lunch window ──────────────────────────────────────────────────────────

test("a shift of exactly 6 hours needs no lunch", () => {
  assert.equal(lunchWindow(assoc({ shiftStart: 0, shiftEnd: 6 })), null);
});

test("a shift over 6 hours needs a lunch, away from both ends", () => {
  assert.deepEqual(lunchWindow(assoc({ shiftStart: 0, shiftEnd: 9 })), { from: 2, to: 7 });
});

test("the window shifts with the shift", () => {
  assert.deepEqual(lunchWindow(assoc({ shiftStart: 4, shiftEnd: 13 })), { from: 6, to: 11 });
});

// ── issues ────────────────────────────────────────────────────────────────

test("a long shift with no lunch is flagged as missing", () => {
  const i = lunchIssue(assoc());
  assert.equal(i.kind, "missing");
  assert.match(i.message, /9h shift has no lunch/);
});

test("a lunch inside the window is clean", () => {
  assert.equal(lunchIssue(assoc({ slots: { 4: "L" } })), null);
});

test("a lunch too near the start or end is flagged", () => {
  assert.equal(lunchIssue(assoc({ slots: { 1: "L" } })).kind, "edge");
  assert.equal(lunchIssue(assoc({ slots: { 8: "L" } })).kind, "edge");
  assert.equal(lunchIssue(assoc({ slots: { 7: "L" } })).kind, "edge", "window end is exclusive");
});

test("two lunches on one day are flagged", () => {
  const i = lunchIssue(assoc({ slots: { 3: "L", 5: "L" } }));
  assert.equal(i.kind, "duplicate");
  assert.match(i.message, /2 lunches/);
});

test("a short shift is never nagged, even with a lunch on it", () => {
  // Below the threshold nothing is required, so an entered lunch is the user's
  // call — not something to warn about.
  assert.equal(lunchIssue(assoc({ shiftEnd: 5, slots: { 1: "L" } })), null);
  assert.equal(lunchIssue(assoc({ shiftEnd: 5 })), null);
});

test("lunch detection is case-insensitive and ignores other tasks", () => {
  assert.deepEqual(lunchSlots(assoc({ slots: { 3: "l", 4: "PICK", 5: "B" } })), [3]);
});

test("an associate with no shift window is not lunch-checked", () => {
  assert.equal(lunchIssue(assoc({ shiftStart: null, shiftEnd: null })), null);
});

// ── summary ───────────────────────────────────────────────────────────────

test("a clean day produces no banner", () => {
  assert.equal(lunchSummary([assoc({ slots: { 4: "L" } })]), null);
});

test("the summary counts each kind of problem", () => {
  const s = lunchSummary([
    assoc({ name: "A" }),                            // missing
    assoc({ name: "B", slots: { 1: "L" } }),         // edge
    assoc({ name: "C", slots: { 3: "L", 5: "L" } }), // duplicate
    assoc({ name: "D", slots: { 4: "L" } }),         // clean
  ]);
  assert.equal(s.count, 3);
  assert.match(s.text, /1 without a lunch/);
  assert.match(s.text, /1 with a lunch at the edge/);
  assert.match(s.text, /1 with more than one lunch/);
});

test("lunchIssues names the people, so the banner can be acted on", () => {
  const issues = lunchIssues([assoc({ name: "ADA" }), assoc({ name: "GRACE", slots: { 4: "L" } })]);
  assert.deepEqual(issues.map((i) => i.name), ["ADA"]);
});
