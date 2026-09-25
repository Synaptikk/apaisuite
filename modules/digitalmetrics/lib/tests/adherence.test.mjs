// modules/digitalmetrics/lib/tests/adherence.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/adherence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findAssignmentMatch, assignedPickHours, breakSlots, breakPickHours, breakTimes,
  effectiveAssignedHours, calculateAdherence, actualPickHoursByName, dateKey, weekPickBreakdown, exceptionSplit,
} from "../data/adherence.js";

const pickSlots = (n, from = 0) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, "Pick"]));

// ── name matching ────────────────────────────────────────────────────────
test("an exact name wins", () => {
  const roster = [{ name: "QUINCY QUILL" }, { name: "QUINCY Q" }];
  assert.equal(findAssignmentMatch("Quincy Quill", roster).name, "QUINCY QUILL");
});

test("first name plus last initial beats bare first name", () => {
  // The ordering matters: two people share the first name, and the initial is
  // the only thing separating them.
  const roster = [{ name: "QUINCY" }, { name: "QUINCY Q" }];
  assert.equal(findAssignmentMatch("QUINCY QUILL", roster).name, "QUINCY Q");
});

test("bare first name is the last-resort fallback", () => {
  const roster = [{ name: "QUINCY" }];
  assert.equal(findAssignmentMatch("QUINCY ZANDER", roster).name, "QUINCY");
});

test("no match returns null rather than a wrong person", () => {
  assert.equal(findAssignmentMatch("JANE DOE", [{ name: "JOHN SMITH" }]), null);
  assert.equal(findAssignmentMatch("", [{ name: "X" }]), null);
  assert.equal(findAssignmentMatch("X", null), null);
});

// ── assigned hours ───────────────────────────────────────────────────────
test("each pick slot is an hour", () => {
  assert.equal(assignedPickHours({ slots: pickSlots(4) }), 4);
});

test("non-pick slots do not count", () => {
  assert.equal(assignedPickHours({ slots: { 0: "Pick", 1: "Lunch", 2: "Disp" } }), 1);
});

test("slots after 7pm are ignored", () => {
  // Slot 14+ is evening; there is nothing left to pick.
  assert.equal(assignedPickHours({ slots: { 13: "Pick", 14: "Pick", 15: "Pick" } }), 1);
});

test("part-hour shift boundaries count as half slots", () => {
  // The shape a SAVED assignment actually has: shiftStart/End are slot
  // indices and the real clock times live on shiftLabel. The old version of
  // this test used the schedule shape ("5:30 AM" in shiftStart), which is
  // not what this function is ever handed — so the half-hour branch it was
  // asserting could never fire in production.
  const a = { slots: pickSlots(3), shiftStart: 0, shiftEnd: 3,
              shiftLabel: "5:30am-7:30am" };
  assert.equal(assignedPickHours(a), 2);   // 0.5 + 1 + 0.5
});

test("a :40 start is charged as half an hour, not a whole one", () => {
  const a = { slots: pickSlots(2), shiftStart: 0, shiftEnd: 2,
              shiftLabel: "5:40am-7:00am" };
  assert.equal(assignedPickHours(a), 1.5);
});

test("an unbounded row still counts its assigned slots", () => {
  // Added by hand, or a schedule that never imported: no window, but the
  // tasks are real. Counting 0 would erase their adherence denominator.
  assert.equal(assignedPickHours({ slots: pickSlots(4) }), 4);
});

test("an absent associate is assigned nothing", () => {
  // Otherwise the plan is billed against them and zero picks are measured
  // against it: a performance problem manufactured out of a day off.
  const a = { slots: pickSlots(4), shiftStart: 0, shiftEnd: 4,
              shiftLabel: "5:00am-9:00am", status: "absent" };
  assert.equal(assignedPickHours(a), 0);
});

test("an empty or missing assignment is zero, not a crash", () => {
  assert.equal(assignedPickHours(null), 0);
  assert.equal(assignedPickHours({}), 0);
});

// ── breaks ───────────────────────────────────────────────────────────────
const row = (start, end, tasks) => ({
  shiftStart: start, shiftEnd: end,
  slots: Object.fromEntries(tasks.map((t, i) => [start + i, t]).filter(([, t]) => t)),
});

test("a full shift: a 15 at the 2-hour mark, lunch, a 15 two hours after lunch", () => {
  // 7am–4pm: 7-8 8-9 9-10 10-11 11-12(L) 12-1 1-2 2-3 3-4
  const a = row(2, 11, ["PICK", "PICK", "PICK", "PICK", "L", "PICK", "PICK", "PICK", "PICK"]);
  assert.deepEqual(breakSlots(a), [3, 8]);   // 8–9am and 1–2pm
  assert.equal(effectiveAssignedHours(a), 8 - 0.5);
});

test("a 6-hour shift takes one 15 in the middle", () => {
  const a = row(0, 6, ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK"]);
  assert.deepEqual(breakSlots(a), [2]);
  assert.equal(effectiveAssignedHours(a), 5.75);
});

test("a break during another task costs no pick time", () => {
  const a = row(2, 11, ["DISP", "DISP", "PICK", "PICK", "L", "PICK", "DISP", "PICK", "PICK"]);
  assert.deepEqual(breakSlots(a), [3, 8]);      // slot 3 is DISP, slot 8 is DISP
  assert.equal(breakPickHours(a), 0);
  assert.equal(effectiveAssignedHours(a), 5);
});

test("breaks the planner placed on the board replace the predicted ones", () => {
  const a = row(0, 6, ["PICK", "PICK", "B", "PICK", "PICK", "PICK"]);
  assert.deepEqual(breakSlots(a), []);
  assert.equal(effectiveAssignedHours(a), 5);
});

test("a short shift takes no break; effective hours never fall to zero", () => {
  assert.deepEqual(breakSlots(row(0, 2, ["PICK", "PICK"])), []);
  assert.equal(effectiveAssignedHours({ slots: {} }), 0);
  // From three worked hours up, one 15 is expected.
  assert.equal(effectiveAssignedHours(row(0, 3, ["PICK", "PICK", "PICK"])), 2.75);
});

// ── end to end ───────────────────────────────────────────────────────────
const assignments = {
  "12/01/25": { associates: [{ name: "JOHN S", slots: pickSlots(8), startSlot: 0, endSlot: 7 }] },
};

test("adherence is actual over effective assigned hours", () => {
  const out = calculateAdherence(
    [{ name: "JOHN SMITH" }], assignments,
    { "JOHN SMITH": { "12/01/25": 7.5 } }, { "JOHN SMITH": "Digital" },
  );
  assert.equal(out["JOHN SMITH"].adherence, 100);
  assert.equal(out["JOHN SMITH"].assignedHours, 7.5);
  assert.equal(out["JOHN SMITH"].isLowAdherence, false);
});

test("under-target adherence is flagged below 70%", () => {
  const out = calculateAdherence(
    [{ name: "JOHN SMITH" }], assignments,
    { "JOHN SMITH": { "12/01/25": 4 } }, { "JOHN SMITH": "Digital" },
  );
  assert.equal(out["JOHN SMITH"].adherence, 53);
  assert.equal(out["JOHN SMITH"].isLowAdherence, true);
});

test("only Digital and Exceptions are scored", () => {
  for (const cls of ["Store Help", "Fashion", "", undefined]) {
    const out = calculateAdherence(
      [{ name: "JOHN SMITH" }], assignments,
      { "JOHN SMITH": { "12/01/25": 7.5 } }, { "JOHN SMITH": cls },
    );
    assert.deepEqual(out, {}, `${cls} should be skipped`);
  }
});

test("a day with zero actual pick hours is skipped, not scored as zero", () => {
  // Scheduled to pick but moved to another task — not the associate's doing.
  const out = calculateAdherence(
    [{ name: "JOHN SMITH" }], assignments,
    { "JOHN SMITH": { "12/01/25": 0 } }, { "JOHN SMITH": "Digital" },
  );
  assert.deepEqual(out, {});
});

test("actual hours are keyed by name and date, forward-filling dates", () => {
  const out = actualPickHoursByName([
    { Associate: "A", "Pick Date": "12/01/25", "Pick Hours": 5 },
    { Associate: "B", "Pick Hours": 3 },                          // inherits date
  ]);
  assert.equal(out.A["2025-12-01"], 5);
  assert.equal(out.B["2025-12-01"], 3);
});

test("metrics and assignment dates join whatever their padding", () => {
  // Tableau writes "9/19/26"; the view used to look up "09/19/26".
  assert.equal(dateKey("9/19/26"), "2026-09-19");
  assert.equal(dateKey("09/19/2026"), "2026-09-19");
  assert.equal(dateKey("2026-09-19"), "2026-09-19");
  const actual = actualPickHoursByName([{ Associate: "JOHN SMITH", "Pick Date": "9/1/26", "Pick Hours": 6 }]);
  const byDate = { "2026-09-01": { associates: [{ name: "JOHN SMITH", slots: pickSlots(6), shiftStart: 0, shiftEnd: 6 }] } };
  const out = calculateAdherence([{ name: "JOHN SMITH" }], byDate, actual, { "JOHN SMITH": "Digital" });
  assert.ok(out["JOHN SMITH"], "a single-digit-month day must produce adherence");
});

test("week breakdown keeps assigned-but-not-picked days and sums by day", () => {
  const byDate = {
    "2026-09-21": { associates: [
      { name: "JOHN SMITH", shiftStart: 0, shiftEnd: 2, slots: { 0: "PICK", 1: "PICK" } },
      { name: "MARY LAKE",  shiftStart: 0, shiftEnd: 2, slots: { 0: "PICK", 1: "PICK" } }] },
  };
  const actual = { "JOHN SMITH": { "2026-09-21": 1.5 } };
  const cls = { "JOHN SMITH": "Digital", "MARY LAKE": "Digital" };
  const { days, people } = weekPickBreakdown(byDate, actual, cls);
  assert.deepEqual(days, [{ date: "2026-09-21", assigned: 4, actual: 1.5, people: 2 }]);
  assert.equal(people.find((p) => p.name === "MARY LAKE").actual, 0);
});

test("exception work is split from picking: board EXC hours against exception items", () => {
  const byDate = { "2026-09-21": { associates: [
    { name: "JOHN SMITH", shiftStart: 0, shiftEnd: 3, slots: { 0: "EXC", 1: "EXC", 2: "PICK" } }] } };
  const rawData = [{ Associate: "JOHN SMITH", "Pick Date": "9/21/26", "Pick Hours": 0.5,
    "Picked As Req Qty": 60, "Exception Qty Req to Pick": 80, "Exception Picked As Req Qty": 70,
    "Exception Nil Pick Qty": 4, "Exception Substitution Qty": 6 }];
  const [r] = exceptionSplit(byDate, rawData);
  assert.equal(r.excHours, 2);
  assert.equal(r.excReq, 80);
  assert.equal(r.pickAssigned, 1);
  assert.equal(r.pickActual, 0.5);
  assert.equal(r.regItems, 60);
});

test("breaks due together are staggered :45, :00, :15 in roster order", () => {
  const shift = () => ["PICK", "PICK", "PICK", "PICK", "L", "PICK", "PICK", "PICK", "PICK"];
  const roster = ["A", "B", "C", "D"].map((name) => ({ name, ...row(2, 11, shift()) }));
  const [a, b, c, d] = roster.map((r) => breakTimes(r, roster));
  // First break ends by 9am (slot 3 = 8–9am); second by 2pm (slot 8 = 1–2pm).
  assert.deepEqual(a.map((t) => t.label), ["8:45", "1:45"]);
  assert.deepEqual(b.map((t) => t.label), ["9:00", "2:00"]);
  assert.deepEqual(c.map((t) => t.label), ["9:15", "2:15"]);
  assert.deepEqual(d.map((t) => t.label), ["8:45", "1:45"]);
  assert.deepEqual(b.map((t) => t.slot), [4, 9]);   // :00 costs the next hour
});

test("a staggered break costs pick time in the hour it actually falls in", () => {
  // B's breaks move to 9–10am (DISP) and 2–3pm (PICK): only one costs pick.
  const tasks = ["PICK", "PICK", "DISP", "PICK", "L", "PICK", "PICK", "PICK", "PICK"];
  const roster = [{ name: "A", ...row(2, 11, tasks) }, { name: "B", ...row(2, 11, tasks) }];
  assert.equal(breakPickHours(roster[0], roster), 0.5);
  assert.equal(breakPickHours(roster[1], roster), 0.25);
  assert.equal(effectiveAssignedHours(roster[1], roster), 7 - 0.25);
});

test("absent associates are not counted in the stagger", () => {
  const tasks = ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK"];
  const roster = [{ name: "A", status: "absent", ...row(0, 6, tasks) }, { name: "B", ...row(0, 6, tasks) }];
  assert.equal(breakTimes(roster[1], roster)[0].minute, 45);
});
