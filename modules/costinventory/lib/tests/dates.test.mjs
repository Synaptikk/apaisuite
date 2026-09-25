import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryDateFor, inventoryWindow, previousNight, shiftDays } from "../dates.js";

test("fourth Tuesday, including five-Tuesday months", () => {
  assert.equal(inventoryDateFor(2026, 7), "2026-08-25");   // Aug 2026 — 4th == last
  assert.equal(inventoryDateFor(2026, 8), "2026-09-22");   // Sep 2026 — last Tue is the 29th
  assert.equal(inventoryDateFor(2026, 9), "2026-10-27");
  assert.equal(inventoryDateFor(2026, 11), "2026-12-22");  // Dec 2026 — last Tue is the 29th
});

test("window on inventory day reaches back a month, not to today", () => {
  assert.deepEqual(inventoryWindow("2026-09-22"), { start: "2026-08-25", end: "2026-09-22" });
});

test("window mid-cycle anchors on the count that already happened", () => {
  assert.deepEqual(inventoryWindow("2026-09-21"), { start: "2026-08-25", end: "2026-09-21" });
  assert.deepEqual(inventoryWindow("2026-09-23"), { start: "2026-09-22", end: "2026-09-23" });
});

test("window rolls across a year boundary", () => {
  assert.deepEqual(inventoryWindow("2027-01-05"), { start: "2026-12-22", end: "2027-01-05" });
});

test("previous night and day shifts", () => {
  assert.equal(previousNight("2026-09-22"), "2026-09-21");
  assert.equal(previousNight("2026-01-01"), "2025-12-31");
  assert.equal(shiftDays("2026-09-21", -10), "2026-09-11");
  assert.equal(shiftDays("2026-09-21", 3), "2026-09-24");
});
