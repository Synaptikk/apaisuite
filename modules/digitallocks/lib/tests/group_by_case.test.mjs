// modules/digitallocks/lib/tests/group_by_case.test.mjs
//
// Pins the Cases tab's grouping (view.js::groupByCase / caseKeyOf).
//
// The tab exists to answer "who has been opening the fragrance case, and
// when" — a question the active queue cannot answer, because it hides
// cleared rows and ranks by risk. Everything pinned here is a property that
// would silently misstate a case's access history if it broke:
//   · store is part of the case key (lock names repeat across stores)
//   · openings count EVERY row, whatever its review status
//   · unattributed rows collapse into one bucket, not one bucket each
//   · after-hours is derived from the hour, not from riskReasons

import test from "node:test";
import assert from "node:assert/strict";

import { groupByCase, caseKeyOf } from "../../view.js";

// Store-local wall-clock hours: parseLockEvents builds Dates with Date.UTC
// from the source's local string, so eventHour IS the local hour.
const isAfterHours = (hr) => hr != null && (hr < 7 || hr >= 23);

function ev(overrides = {}) {
  const base = {
    store: "1458", zoneName: "HBA", lockName: "Fragrance 1",
    userId: "u1", fullName: "Ashley B", position: "Cap 2 Team Associate",
    unlockSource: "App", riskScore: 0, riskLevel: "Normal",
    reviewStatus: "active",
    eventTime: "2026-08-20T09:00:00.000Z", eventDate: "2026-08-20", eventHour: 9,
  };
  return { ...base, ...overrides };
}

test("case key includes the store — same lock name at two stores stays two cases", () => {
  const cases = groupByCase([ev(), ev({ store: "1459" })], isAfterHours);
  assert.equal(cases.length, 2);
  assert.notEqual(caseKeyOf(cases[0].events[0]), caseKeyOf(cases[1].events[0]));
});

test("openings count cleared and non-malicious rows too", () => {
  const cases = groupByCase([
    ev(),
    ev({ reviewStatus: "non_malicious", eventHour: 10 }),
    ev({ reviewStatus: "dismissed", eventHour: 11 }),
  ], isAfterHours);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].openings, 3);
});

test("after-hours is derived from the hour, not from riskReasons", () => {
  // Calibration can strip the AFTERHOURS reason out of a scored event when
  // the store opens at 3am routinely. The case history must still say 3am.
  const cases = groupByCase([
    ev({ eventHour: 3, riskReasons: [], riskScore: 0, riskLevel: "Normal" }),
    ev({ eventHour: 14 }),
  ], isAfterHours);
  assert.equal(cases[0].afterHours, 1);
});

test("openers rank by openings and carry their own first/last/after-hours", () => {
  const cases = groupByCase([
    ev({ userId: "u1", fullName: "Ashley B", eventTime: "2026-08-20T09:00:00.000Z", eventHour: 9 }),
    ev({ userId: "u1", fullName: "Ashley B", eventTime: "2026-08-20T23:30:00.000Z", eventHour: 23 }),
    ev({ userId: "u2", fullName: "Chris D",  eventTime: "2026-08-21T10:00:00.000Z", eventHour: 10, eventDate: "2026-08-21" }),
  ], isAfterHours);
  const [c] = cases;
  assert.equal(c.people, 2);
  assert.equal(c.openers[0].name, "Ashley B");
  assert.equal(c.openers[0].openings, 2);
  assert.equal(c.openers[0].afterHours, 1);
  assert.equal(c.topOpener.userId, "u1");
  assert.equal(new Date(c.firstMs).toISOString(), "2026-08-20T09:00:00.000Z");
  assert.equal(new Date(c.lastMs).toISOString(),  "2026-08-21T10:00:00.000Z");
});

test("unattributed rows collapse into one opener bucket", () => {
  const cases = groupByCase([
    ev({ userId: "", fullName: "" }),
    ev({ userId: "", fullName: "", eventHour: 10 }),
    ev({ userId: "u1" }),
  ], isAfterHours);
  const [c] = cases;
  assert.equal(c.people, 2);                       // one real user + one unattributed bucket
  const unattributed = c.openers.find((u) => !u.userId);
  assert.equal(unattributed.openings, 2);
});

test("days are ascending [dayKey, count] pairs", () => {
  const cases = groupByCase([
    ev({ eventDate: "2026-08-21", eventTime: "2026-08-21T09:00:00.000Z" }),
    ev({ eventDate: "2026-08-20" }),
    ev({ eventDate: "2026-08-20", eventHour: 10 }),
  ], isAfterHours);
  assert.deepEqual(cases[0].days, [["2026-08-20", 2], ["2026-08-21", 1]]);
});

test("flagged counts High and Critical only", () => {
  const cases = groupByCase([
    ev({ riskLevel: "Critical", riskScore: 80 }),
    ev({ riskLevel: "High",     riskScore: 60 }),
    ev({ riskLevel: "Watch",    riskScore: 30 }),
    ev(),
  ], isAfterHours);
  assert.equal(cases[0].flagged, 2);
  assert.equal(cases[0].maxScore, 80);
});

test("rows with an unparseable timestamp still count as openings", () => {
  const cases = groupByCase([
    ev({ eventTime: "not a date", eventDate: null, eventHour: null }),
    ev(),
  ], isAfterHours);
  assert.equal(cases[0].openings, 2);
  assert.equal(new Date(cases[0].firstMs).toISOString(), "2026-08-20T09:00:00.000Z");
});
