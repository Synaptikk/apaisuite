// modules/digitalmetrics/lib/tests/schedule_import.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/schedule_import.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedulePayload } from "../data/schedule_import.js";

const payload = (over = {}) => JSON.stringify({
  store: "1458",
  schedules: {
    "2026-01-03": { associates: [{ name: "john smith", startSlot: 0, endSlot: 8 }] },
  },
  ...over,
});

test("a good payload parses and normalises names", () => {
  const res = parseSchedulePayload(payload());
  assert.ok(res.ok);
  assert.deepEqual(res.dates, ["2026-01-03"]);
  assert.equal(res.schedules["2026-01-03"].associates[0].name, "JOHN SMITH");
  assert.equal(res.store, "1458");
  assert.equal(res.associateCount, 1);
});

test("malformed JSON gives a message, not an exception", () => {
  const res = parseSchedulePayload("{not json");
  assert.equal(res.ok, false);
  assert.match(res.reason, /valid JSON/);
});

test("a payload with no schedules is rejected", () => {
  assert.equal(parseSchedulePayload(JSON.stringify({ schedules: {} })).ok, false);
  assert.equal(parseSchedulePayload(JSON.stringify({ foo: 1 })).ok, false);
  assert.equal(parseSchedulePayload("null").ok, false);
});

test("bad dates and empty days are skipped with a warning, not written", () => {
  const res = parseSchedulePayload(JSON.stringify({
    schedules: {
      "not-a-date": { associates: [{ name: "A" }] },
      "2026-01-03": { associates: [] },
      "2026-01-04": { associates: [{ name: "B" }] },
    },
  }));
  assert.ok(res.ok);
  assert.deepEqual(res.dates, ["2026-01-04"]);
  assert.equal(res.warnings.length, 2);
});

test("unnamed rows are dropped — they cannot be matched to anyone", () => {
  const res = parseSchedulePayload(JSON.stringify({
    schedules: { "2026-01-03": { associates: [{ name: "" }, { name: "  " }, { name: "REAL" }] } },
  }));
  assert.equal(res.schedules["2026-01-03"].associates.length, 1);
});

test("slot indices are clamped into the grid", () => {
  const res = parseSchedulePayload(JSON.stringify({
    schedules: { "2026-01-03": { associates: [{ name: "A", startSlot: -5, endSlot: 99 }] } },
  }));
  const a = res.schedules["2026-01-03"].associates[0];
  assert.equal(a.startSlot, 0);
  assert.equal(a.endSlot, 17);
});

test("non-numeric slots become null rather than NaN", () => {
  const res = parseSchedulePayload(JSON.stringify({
    schedules: { "2026-01-03": { associates: [{ name: "A", startSlot: "x" }] } },
  }));
  assert.equal(res.schedules["2026-01-03"].associates[0].startSlot, null);
});

test("an object may be passed directly, not only a string", () => {
  assert.ok(parseSchedulePayload(JSON.parse(payload())).ok);
});
