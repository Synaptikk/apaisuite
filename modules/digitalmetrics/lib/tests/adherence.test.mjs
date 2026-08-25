// modules/digitalmetrics/lib/tests/adherence.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/adherence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findAssignmentMatch, assignedPickHours, breakAllowance,
  effectiveAssignedHours, calculateAdherence, actualPickHoursByName,
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

test("half-hour shift boundaries count as half slots", () => {
  const a = { slots: pickSlots(3), startSlot: 0, endSlot: 2,
              shiftStart: "5:30 AM", shiftEnd: "1:30 PM" };
  assert.equal(assignedPickHours(a), 2);   // 0.5 + 1 + 0.5
});

test("an empty or missing assignment is zero, not a crash", () => {
  assert.equal(assignedPickHours(null), 0);
  assert.equal(assignedPickHours({}), 0);
});

// ── break allowance ──────────────────────────────────────────────────────
test("no break is charged when picking is a minority of the shift", () => {
  // 1 pick hour in a 6-hour shift: the break happens on other work.
  assert.equal(breakAllowance(1, 6), 0);
  assert.equal(breakAllowance(3, 6), 0);   // exactly half still does not qualify
});

test("a long shift earns 30 minutes, a short one 15, prorated by pick share", () => {
  assert.equal(breakAllowance(8, 8), 0.5);        // all-pick 8h shift
  assert.equal(breakAllowance(6, 6), 0.25);       // all-pick 6h shift (not >6)
  assert.equal(breakAllowance(6, 8), 0.5 * 0.75); // 75% picking
});

test("effective hours subtract the break but never fall to zero", () => {
  assert.equal(effectiveAssignedHours({ slots: pickSlots(8), startSlot: 0, endSlot: 7 }), 7.5);
  assert.equal(effectiveAssignedHours({ slots: {} }), 0);
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
  assert.equal(out.A["12/01/25"], 5);
  assert.equal(out.B["12/01/25"], 3);
});
