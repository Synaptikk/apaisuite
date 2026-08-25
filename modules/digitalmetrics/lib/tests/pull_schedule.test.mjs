// modules/digitalmetrics/lib/tests/pull_schedule.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isoDay, daysBack, datesToPull, isPullDue, LOOKBACK_DAYS, VOLATILE_DAYS,
} from "../pull_schedule.js";

const NOW = new Date(2026, 7, 25);   // 2026-08-25, local

test("isoDay formats in LOCAL time", () => {
  assert.equal(isoDay(new Date(2026, 7, 25)), "2026-08-25");
  // A UTC-based formatter would render this as the 25th in a negative-offset
  // zone; the local one must not.
  assert.equal(isoDay(new Date(2026, 0, 1)), "2026-01-01");
});

test("daysBack counts backwards from the day BEFORE `from`", () => {
  assert.deepEqual(daysBack(NOW, 3), ["2026-08-24", "2026-08-23", "2026-08-22"]);
});

test("daysBack crosses a month boundary", () => {
  assert.deepEqual(daysBack(new Date(2026, 8, 2), 3), ["2026-09-01", "2026-08-31", "2026-08-30"]);
});

test("today is never pulled — the day is not complete yet", () => {
  assert.ok(!datesToPull(NOW, []).includes("2026-08-25"));
});

test("with nothing stored, the whole lookback window is pulled", () => {
  assert.equal(datesToPull(NOW, []).length, LOOKBACK_DAYS);
});

test("dates already stored are skipped", () => {
  const all = datesToPull(NOW, []);
  const have = all.slice(2);                 // everything except the newest two
  const next = datesToPull(NOW, have);
  assert.deepEqual(next, all.slice(0, 2));
});

test("the most recent days are ALWAYS re-pulled even when stored", () => {
  // Fulfilment numbers keep settling after midnight. Treating a stored day as
  // final on the day it happened bakes in a partial number for good.
  const all = datesToPull(NOW, []);
  const everything = [...all];
  const again = datesToPull(NOW, everything);
  assert.equal(again.length, VOLATILE_DAYS);
  assert.deepEqual(again, daysBack(NOW, VOLATILE_DAYS));
});

test("a fully-stored history beyond the volatile window pulls only the volatile days", () => {
  const again = datesToPull(NOW, datesToPull(NOW, []), { lookback: 8, volatile: 1 });
  assert.deepEqual(again, ["2026-08-24"]);
});

test("isPullDue is true when nothing has run", () => {
  assert.equal(isPullDue(NOW, 0, { minGapMs: 1000 }), true);
  assert.equal(isPullDue(NOW, null, { minGapMs: 1000 }), true);
});

test("isPullDue enforces the minimum gap", () => {
  const now = new Date(2026, 7, 25, 12, 0, 0);
  const justNow = now.getTime() - 60_000;
  assert.equal(isPullDue(now, justNow, { minGapMs: 45 * 60_000 }), false);

  const ages = now.getTime() - 90 * 60_000;
  assert.equal(isPullDue(now, ages, { minGapMs: 45 * 60_000 }), true);
});
