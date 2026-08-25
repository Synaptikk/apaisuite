// modules/digitalmetrics/lib/tests/wfm_parse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays, toMinutes, formatTime, toSlot, buildSchedules, DAY_INDEX_ORDER,
} from "../data/wfm_parse.js";
import { TIME_SLOTS } from "../data/grid.js";

test("day index order is Saturday-first, matching weekEvents", () => {
  assert.equal(DAY_INDEX_ORDER[0], "SAT");
  assert.equal(DAY_INDEX_ORDER[6], "FRI");
});

test("addDays stays in local time across a month boundary", () => {
  assert.equal(addDays("2026-08-22", 0), "2026-08-22");
  assert.equal(addDays("2026-08-22", 6), "2026-08-28");
  assert.equal(addDays("2026-08-30", 3), "2026-09-02");
});

test("addDays does not drift a day the way a UTC parse would", () => {
  // new Date("2026-08-22") is UTC midnight; in any negative-offset zone that
  // is the 21st locally. This must not happen.
  assert.equal(addDays("2026-08-22", 1), "2026-08-23");
});

test("addDays rejects junk", () => {
  assert.equal(addDays("not-a-date", 1), null);
});

test("toMinutes reads ISO datetimes", () => {
  assert.equal(toMinutes("2026-08-22T13:30:00"), 13 * 60 + 30);
  assert.equal(toMinutes("2026-08-22T04:00:00"), 4 * 60);
});

test("toMinutes reads rendered 12-hour text", () => {
  assert.equal(toMinutes("9:00am"), 9 * 60);
  assert.equal(toMinutes("1:30 pm"), 13 * 60 + 30);
  assert.equal(toMinutes("12:00am"), 0);
  assert.equal(toMinutes("12:00pm"), 12 * 60);
});

test("toMinutes reads a Luxon-shaped object", () => {
  assert.equal(toMinutes({ c: { hour: 6, minute: 15 } }), 6 * 60 + 15);
});

test("toMinutes returns null rather than guessing", () => {
  assert.equal(toMinutes(null), null);
  assert.equal(toMinutes("Available"), null);
  assert.equal(toMinutes("Time Off"), null);
});

test("formatTime round-trips through toMinutes", () => {
  for (const t of ["5:00am", "9:30am", "12:00pm", "1:15pm", "10:45pm"]) {
    assert.equal(formatTime(toMinutes(t)), t);
  }
});

test("toSlot maps 5am to slot 0, matching TIME_SLOTS", () => {
  assert.equal(TIME_SLOTS[0], "5-6");
  assert.deepEqual(toSlot(5 * 60), { slot: 0, clamped: false });
  assert.deepEqual(toSlot(6 * 60), { slot: 1, clamped: false });
});

test("pre-5am shifts clamp to slot 0 but are REPORTED as clamped", () => {
  // The donor did this silently with Math.max(0, h - 5), filing a 4am start in
  // the same cell as a 5am one. The clamp is unavoidable; the silence was not.
  const early = toSlot(4 * 60);
  assert.equal(early.slot, 0);
  assert.equal(early.clamped, true);

  const onTime = toSlot(5 * 60);
  assert.equal(onTime.slot, 0);
  assert.equal(onTime.clamped, false, "a real 5am start must not be flagged");
});

test("late shifts clamp to the end of the grid and are reported", () => {
  const late = toSlot(23 * 60);
  assert.equal(late.slot, TIME_SLOTS.length);
  assert.equal(late.clamped, true);
});

// ── buildSchedules ────────────────────────────────────────────────────────

const extract = (over = {}) => ({
  store: "1458",
  weekStart: "2026-08-22",
  workers: [
    {
      name: "Ada Lovelace",
      days: [
        { index: 0, type: "shift", start: "2026-08-22T09:00:00", end: "2026-08-22T17:00:00" },
        { index: 2, type: "shift", start: "2026-08-24T06:00:00", end: "2026-08-24T15:00:00" },
      ],
    },
    {
      name: "Grace Hopper",
      days: [
        { index: 0, type: "shift", start: "2026-08-22T05:00:00", end: "2026-08-22T09:00:00" },
      ],
    },
  ],
  ...over,
});

test("buildSchedules keys days by date, Saturday-first from weekStart", () => {
  const r = buildSchedules(extract());
  assert.equal(r.ok, true);
  assert.deepEqual(r.dates, ["2026-08-22", "2026-08-24"]);
  assert.equal(r.schedules["2026-08-22"].associates.length, 2);
  assert.equal(r.schedules["2026-08-24"].associates.length, 1);
});

test("buildSchedules emits the shape parseSchedulePayload validates", () => {
  const a = buildSchedules(extract()).schedules["2026-08-22"].associates[0];
  // jobName rides along so classification can be derived from the scheduler
  // instead of ticked by hand (data/job_classify.js); it is in codec.js's
  // SCHEDULE_FIELDS allowlist, so it survives a round trip.
  assert.deepEqual(Object.keys(a).sort(),
    ["endSlot", "jobName", "name", "shiftEnd", "shiftStart", "startSlot"]);
  assert.equal(a.name, "ADA LOVELACE", "names are upper-cased at the boundary");
  assert.equal(a.startSlot, 4);   // 9am → 9 - 5
  assert.equal(a.endSlot, 12);    // 5pm → 17 - 5
});

test("days without a shift are skipped without being an error", () => {
  const r = buildSchedules(extract({
    workers: [{
      name: "Ada Lovelace",
      days: [
        { index: 0, type: "shift", start: "2026-08-22T09:00:00", end: "2026-08-22T17:00:00" },
        { index: 1, type: "available", start: null, end: null },
      ],
    }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.associateCount, 1);
  assert.ok(!r.warnings.some((w) => /no readable start/.test(w)));
});

test("an extraction with workers but zero shifts FAILS loudly", () => {
  // This is precisely the donor's silent failure mode: 351 workers, 0 shifts,
  // reported as success. It must not be reportable as success here.
  const r = buildSchedules(extract({
    workers: [{ name: "Ada Lovelace", days: [] }, { name: "Grace Hopper", days: [] }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /0 shifts/);
});

test("a missing or malformed weekStart fails rather than guessing today", () => {
  assert.equal(buildSchedules(extract({ weekStart: null })).ok, false);
  assert.equal(buildSchedules(extract({ weekStart: "8/22/2026" })).ok, false);
});

test("clamped shifts are counted and surfaced as a warning", () => {
  const r = buildSchedules(extract({
    workers: [{
      name: "Night Owl",
      days: [{ index: 0, type: "shift", start: "2026-08-22T04:00:00", end: "2026-08-22T13:00:00" }],
    }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.clampedCount, 1);
  assert.ok(r.warnings.some((w) => /clamped/.test(w)));
  // The true time survives even though the slot does not.
  assert.equal(r.schedules["2026-08-22"].associates[0].shiftStart, "4:00am");
  assert.equal(r.schedules["2026-08-22"].associates[0].startSlot, 0);
});

test("unnamed workers are skipped and counted", () => {
  const r = buildSchedules(extract({
    workers: [
      { name: "", days: [{ index: 0, type: "shift", start: "2026-08-22T09:00:00", end: "2026-08-22T17:00:00" }] },
      { name: "Ada Lovelace", days: [{ index: 0, type: "shift", start: "2026-08-22T09:00:00", end: "2026-08-22T17:00:00" }] },
    ],
  }));
  assert.equal(r.associateCount, 1);
  assert.ok(r.warnings.some((w) => /no usable name/.test(w)));
});

test("out-of-range day indices are ignored", () => {
  const r = buildSchedules(extract({
    workers: [{
      name: "Ada Lovelace",
      days: [
        { index: 7, type: "shift", start: "2026-08-29T09:00:00", end: "2026-08-29T17:00:00" },
        { index: 0, type: "shift", start: "2026-08-22T09:00:00", end: "2026-08-22T17:00:00" },
      ],
    }],
  }));
  assert.deepEqual(r.dates, ["2026-08-22"]);
});
