// modules/digitalmetrics/lib/tests/weeks.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/weeks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLocal, formatKey, weekKey, previousWeekKey,
  weekNumber, formatWeekDisplay, datesInWeek,
} from "../data/weeks.js";

test("weeks are keyed by the Saturday on or before the date", () => {
  assert.equal(weekKey("2025-11-29"), "2025-11-29");  // a Saturday → itself
  assert.equal(weekKey("2025-12-01"), "2025-11-29");  // Monday → prior Sat
  assert.equal(weekKey("2025-12-05"), "2025-11-29");  // Friday  → same week
  assert.equal(weekKey("2025-12-06"), "2025-12-06");  // next Sat → new week
});

test("dates parse as local midnight, not UTC", () => {
  // The donor's whole calendar slips a day without this.
  const d = parseLocal("2025-12-01");
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 0);
  assert.equal(formatKey(d), "2025-12-01");
});

test("previousWeekKey steps back exactly one week", () => {
  assert.equal(previousWeekKey(parseLocal("2025-12-03")), "2025-11-22");
});

test("fiscal week 1 starts on the Saturday on or before Feb 1", () => {
  // Feb 1 2025 is a Saturday, so it is itself week 1 day 1.
  assert.deepEqual(weekNumber("2025-02-01"), { week: 1, year: 2025 });
  assert.deepEqual(weekNumber("2025-02-07"), { week: 1, year: 2025 });
  assert.deepEqual(weekNumber("2025-02-08"), { week: 2, year: 2025 });
});

test("dates before Feb 1 belong to the previous fiscal year", () => {
  const jan = weekNumber("2026-01-15");
  assert.equal(jan.year, 2025);
  assert.ok(jan.week > 45, `expected a late-year week, got ${jan.week}`);
});

test("formatWeekDisplay spans Saturday to Friday", () => {
  assert.match(formatWeekDisplay("2025-11-29"), /^Week \d+ \(11\/29 - 12\/5\)$/);
});

test("blank Pick Date cells inherit the last seen date", () => {
  // The source report only stamps the date on the first row of each group.
  const rows = [
    { "Pick Date": "12/01/25" }, {}, {},
    { "Pick Date": "12/02/25" }, {},
  ];
  assert.deepEqual(datesInWeek(rows), ["12/01/25", "12/02/25"]);
});

test("datesInWeek tolerates empty and missing input", () => {
  assert.deepEqual(datesInWeek([]), []);
  assert.deepEqual(datesInWeek(undefined), []);
});
