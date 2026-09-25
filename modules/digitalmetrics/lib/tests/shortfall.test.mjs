// modules/digitalmetrics/lib/tests/shortfall.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/shortfall.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { dayShortfall, underPickLeaders, longMeals, capacityRow } from "../data/shortfall.js";

const ISO = "2026-09-19";
// slot 0 = 5–6am. An 8-hour 5am–1pm picker: pick 0–3, lunch 4, pick 5–7.
const picker = (name, over = {}) => ({
  name, shiftStart: 0, shiftEnd: 8, status: null,
  slots: { 0: "PICK", 1: "PICK", 2: "PICK", 3: "PICK", 4: "L", 5: "PICK", 6: "PICK", 7: "PICK" },
  ...over,
});
const clock = (over = {}) => ({ clockIn: 300, clockOut: 780, mealOut: 540, mealIn: 600, ...over });

test("a present picker's gap lands in underPick", () => {
  const d = dayShortfall([picker("A")], [], { A: clock() }, { A: { [ISO]: 4 } }, ISO);
  assert.ok(d.plan > 0);
  assert.equal(d.delivered, 4);
  assert.ok(d.buckets.underPick > 0);
  assert.equal(d.people.underPick[0].name, "A");
});

test("board-absent and no-punch rows are call-ins at full plan", () => {
  const d = dayShortfall(
    [picker("A", { status: "absent" }), picker("B")],
    [], { B: { clockIn: null, clockOut: null } }, {}, ISO);
  assert.equal(d.people.callin.length, 2);
  assert.equal(d.buckets.reassigned, 0);
});

test("no punches without clock coverage is NOT a call-in", () => {
  // Empty clockDay = the pull has not run; nobody can be judged absent.
  const d = dayShortfall([picker("A")], [], {}, {}, ISO);
  assert.equal(d.buckets.callin, 0);
  assert.equal(d.clockCoverage, false);
});

test("a no-show dispenser still costs pick hours (fungible team)", () => {
  const disp = { name: "D", shiftStart: 0, shiftEnd: 8, status: "absent",
    slots: { 0: "DISPENSE", 1: "DISPENSE", 2: "DISPENSE" } };
  const d = dayShortfall([disp], [], { D: {} }, {}, ISO);
  assert.equal(d.buckets.callin, 3);
  assert.equal(d.people.callin[0].note, "non-pick tasks");
});

test("scheduled digital erased from the board count as call-ins; leadership never does", () => {
  const schedule = [
    { name: "GONE", jobName: "Digital Personal Shopper", startSlot: 0, endSlot: 8 },
    { name: "COACH", jobName: "Digital Coach", startSlot: 0, endSlot: 8 },
  ];
  const d = dayShortfall([], schedule, { GONE: {}, COACH: {} }, {}, ISO);
  assert.equal(d.people.callin.length, 1);
  assert.equal(d.people.callin[0].name, "GONE");
  assert.equal(d.people.callin[0].hours, 8, "9 slots less an hour's lunch");
});

test("a scheduled person missing from GTA entirely is unknowable, not absent", () => {
  const schedule = [{ name: "MYSTERY", jobName: "Digital Personal Shopper", startSlot: 0, endSlot: 8 }];
  const d = dayShortfall([], schedule, { OTHER: clock() }, {}, ISO);
  assert.equal(d.buckets.callin, 0);
});

test("lunch on a pick hour shrinks the plan instead of blaming anyone", () => {
  // Lunch punch 10:00–11:00 lands on pick slot 5 (10–11am).
  const base = dayShortfall([picker("A")], [], { A: clock({ mealOut: null, mealIn: null }) },
    { A: { [ISO]: 5 } }, ISO);
  const withLunch = dayShortfall([picker("A")], [], { A: clock({ mealOut: 600, mealIn: 660 }) },
    { A: { [ISO]: 5 } }, ISO);
  assert.ok(withLunch.plan < base.plan);
  assert.ok(withLunch.buckets.underPick < base.buckets.underPick);
});

test("late arrival into pick hours is tardy, not underPick", () => {
  // Clock in 7:00 with pick from 5:00 → slots 0 and 1 missed.
  const d = dayShortfall([picker("A")], [], { A: clock({ clockIn: 420 }) }, { A: { [ISO]: 5 } }, ISO);
  assert.equal(d.buckets.tardy, 2);
});

test("worked but zero picks is reassigned", () => {
  const d = dayShortfall([picker("A")], [], { A: clock() }, {}, ISO);
  assert.ok(d.buckets.reassigned > 0);
  assert.equal(d.buckets.underPick, 0);
});

test("underPickLeaders tags bagging, multi-task, slow and leak", () => {
  const rows = [
    { "Pick Date": "9/19/26", Associate: "FAST", "Pick Rate": 170, "Exception Qty Req to Pick": 0 },
    { Associate: "SLOW", "Pick Rate": 40, "Exception Qty Req to Pick": 0 },
    { Associate: "EXC", "Pick Rate": 90, "Exception Qty Req to Pick": 300 },
    { Associate: "MID1", "Pick Rate": 90, "Exception Qty Req to Pick": 0 },
    { Associate: "MID2", "Pick Rate": 91, "Exception Qty Req to Pick": 0 },
  ];
  const day = {
    roster: ["FAST", "SLOW", "EXC", "MID1", "MID2"].map((n) => picker(n)),
    schedule: [], iso: ISO,
    clockDay: Object.fromEntries(["FAST", "SLOW", "EXC", "MID1", "MID2"].map((n) => [n, clock()])),
    actualByName: Object.fromEntries(["FAST", "SLOW", "EXC", "MID1", "MID2"].map((n) => [n, { [ISO]: 4 }])),
  };
  const res = underPickLeaders([day], rows);
  const read = (n) => res.list.find((p) => p.name === n)?.read;
  assert.equal(read("FAST"), "bagging");
  assert.equal(read("SLOW"), "slow");
  assert.equal(read("EXC"), "multi-task", ">100 exception items explains the gap");
  assert.equal(read("MID1"), "leak");
  assert.equal(res.totals.all,
    res.totals.bagging + res.totals.multiTask + res.totals.slow + res.totals.leak);
});

test("longMeals flags only windows over 70 minutes", () => {
  const flags = longMeals({
    [ISO]: {
      OK:   { mealOut: 600, mealIn: 665 },   // 65m
      LONG: { mealOut: 600, mealIn: 675 },   // 75m
      NONE: { mealOut: null, mealIn: null },
    },
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].name, "LONG");
  assert.equal(flags[0].over, 15);
});

test("capacityRow prices express at its own slower rate", () => {
  const r = capacityRow({ units: 9300, expressUnits: 600, plan: 100, delivered: 80, helpHours: 15 });
  // (9300-600)/93 + 600/60 = 93.5 + 10 = 103.5
  assert.equal(r.required, 103.5);
  assert.equal(r.planVsRequired, -3.5);
  assert.equal(r.deliveredVsRequired, -8.5);
});
