// modules/digitalmetrics/lib/tests/grid.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/grid.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIME_SLOTS, resolveShortcut, isHalfSlot, summarise,
  fillPercentage, isFinalized, dayName, defaultDate, emptyAssociate, isAbsent,
  slotCoverage,
  PICKS_PER_PICKER_HOUR,
} from "../data/grid.js";

const assoc = (over = {}) => ({
  name: "A", slots: {}, shiftStart: 0, shiftEnd: 8, shiftLabel: "5:00-1:00", ...over,
});

test("the grid covers 5am to 10pm in 17 hourly slots", () => {
  assert.equal(TIME_SLOTS.length, 17);
  assert.equal(TIME_SLOTS[0], "5-6");
  assert.equal(TIME_SLOTS.at(-1), "9-10P");
});

test("keyboard shortcuts resolve in either case, and three keys clear", () => {
  assert.equal(resolveShortcut("p"), "PICK");
  assert.equal(resolveShortcut("P"), "PICK");
  assert.equal(resolveShortcut("R"), "PREP");   // not P - Pick owns that
  assert.equal(resolveShortcut("q"), "QC");
  assert.equal(resolveShortcut("v"), "DRV");
  assert.equal(resolveShortcut("n"), "DS");
  assert.equal(resolveShortcut("t"), "TRN");
  assert.equal(resolveShortcut("g"), undefined, "GMD was removed from the vocabulary");
  assert.equal(resolveShortcut("x"), "");
  assert.equal(resolveShortcut("Delete"), "");
  assert.equal(resolveShortcut("Backspace"), "");
  assert.equal(resolveShortcut("z"), undefined, "unmapped keys must not clear a cell");
});

// ── half slots ───────────────────────────────────────────────────────────
test("a partly-worked slot is half; a fully-worked one is not", () => {
  // 5:30-9:30 works half of the 5-6 hour and half of the 9-10 hour. Slot 3
  // (8-9) is worked end to end, so it is NOT half — the old rule flagged it
  // purely because the label ended in ":30", without checking which hour
  // that :30 actually fell in.
  const a = assoc({ shiftStart: 0, shiftEnd: 5, shiftLabel: "5:30-9:30" });
  assert.equal(isHalfSlot(a, 0), true,  "first slot, :30 start");
  assert.equal(isHalfSlot(a, 4), true,  "last slot, :30 end");
  assert.equal(isHalfSlot(a, 3), false, "8-9 is worked in full");
  assert.equal(isHalfSlot(a, 1), false);
});

test("a whole-hour shift has no half slots", () => {
  const a = assoc({ shiftLabel: "5:00-1:00" });
  assert.equal(isHalfSlot(a, 0), false);
});

test("a missing or malformed shift label is not a half slot", () => {
  assert.equal(isHalfSlot(assoc({ shiftLabel: null }), 0), false);
  assert.equal(isHalfSlot(assoc({ shiftLabel: "nonsense" }), 0), false);
  assert.equal(isHalfSlot({}, 0), false);
});

// ── summary ──────────────────────────────────────────────────────────────
test("staffing counts are per slot, per task", () => {
  const { counts } = summarise([
    assoc({ name: "A", slots: { 0: "PICK", 1: "DISP" } }),
    assoc({ name: "B", slots: { 0: "PICK", 1: "STAGE" } }),
  ]);
  assert.equal(counts.pickers[0], 2);
  assert.equal(counts.disp[1], 1);
  assert.equal(counts.stage[1], 1);
  assert.equal(counts.pickers[2], 0);
});

test("task matching is case-insensitive and ignores unknown tasks", () => {
  const { counts } = summarise([assoc({ slots: { 0: "pick", 1: "Lunch" } })]);
  assert.equal(counts.pickers[0], 1);
  for (const row of Object.values(counts)) assert.equal(row[1], 0);
});

test("estimated picks scale with picker headcount", () => {
  const { estimatedPicks } = summarise([
    assoc({ name: "A", slots: { 0: "PICK" } }),
    assoc({ name: "B", slots: { 0: "PICK" } }),
  ]);
  assert.equal(estimatedPicks[0], 2 * PICKS_PER_PICKER_HOUR);
});

test("a partly-worked slot counts as half a person, not zero and not one", () => {
  const { counts } = summarise([
    assoc({ shiftStart: 0, shiftEnd: 4, shiftLabel: "5:30-9:30", slots: { 0: "PICK", 1: "PICK" } }),
  ]);
  assert.equal(counts.pickers[0], 0.5, "half an hour worked is half a person");
  assert.equal(counts.pickers[1], 1);
});

test("empty cells fall back to a suggestion, tracked separately", () => {
  const { counts, suggested } = summarise(
    [assoc({ name: "A", slots: { 0: "PICK" } }), assoc({ name: "B", slots: {} })],
    { B: { 0: { task: "PICK", confidence: 80 } } },
  );
  assert.equal(counts.pickers[0], 2, "shows what the day would look like");
  assert.equal(suggested.pickers[0], 1, "one of them is only proposed");
});

test("a filled cell wins over a suggestion for the same slot", () => {
  const { counts, suggested } = summarise(
    [assoc({ name: "A", slots: { 0: "DISP" } })],
    { A: { 0: { task: "PICK" } } },
  );
  assert.equal(counts.disp[0], 1);
  assert.equal(counts.pickers[0], 0);
  assert.equal(suggested.disp[0], 0);
});

test("summarising nothing yields zeroed rows, not undefined", () => {
  const { counts } = summarise([]);
  assert.equal(counts.pickers.length, TIME_SLOTS.length);
  assert.ok(counts.pickers.every((n) => n === 0));
});

// ── fill ─────────────────────────────────────────────────────────────────
test("fill percentage counts only slots inside the shift", () => {
  // An 8am starter's 5am cell is not an unfilled assignment.
  assert.equal(fillPercentage([assoc({ shiftStart: 0, shiftEnd: 4, slots: { 0: "PICK", 1: "PICK" } })]), 50);
  assert.equal(fillPercentage([assoc({ shiftStart: 3, shiftEnd: 5, slots: { 3: "PICK", 4: "PICK" } })]), 100);
});

test("whitespace-only cells do not count as filled", () => {
  assert.equal(fillPercentage([assoc({ shiftStart: 0, shiftEnd: 2, slots: { 0: "   ", 1: "PICK" } })]), 50);
});

test("fill percentage of an empty roster is zero, not NaN", () => {
  assert.equal(fillPercentage([]), 0);
});

// ── finalise ─────────────────────────────────────────────────────────────
const today = new Date(2026, 0, 15);
const full  = (date) => ({
  date, associates: [assoc({ shiftStart: 0, shiftEnd: 2, slots: { 0: "PICK", 1: "PICK" } })],
});

test("an explicit flag always wins in both directions", () => {
  assert.equal(isFinalized({ ...full("2026-01-10"), finalized: false }, { today }), false);
  assert.equal(isFinalized({ ...full("2026-01-20"), finalized: true }, { today }), true);
});

test("a past day that was substantially filled locks itself", () => {
  assert.equal(isFinalized(full("2026-01-10"), { today }), true);
});

test("a past day that was barely filled does not lock", () => {
  const sparse = { date: "2026-01-10",
    associates: [assoc({ shiftStart: 0, shiftEnd: 10, slots: { 0: "PICK" } })] };
  assert.equal(isFinalized(sparse, { today }), false);
});

test("today and future days never auto-lock", () => {
  assert.equal(isFinalized(full("2026-01-15"), { today }), false);
  assert.equal(isFinalized(full("2026-01-20"), { today }), false);
});

test("a document with no date is not finalised", () => {
  assert.equal(isFinalized({}, { today }), false);
  assert.equal(isFinalized(null, { today }), false);
});

// ── misc ─────────────────────────────────────────────────────────────────
test("day names map from ISO dates", () => {
  assert.equal(dayName("2026-01-15"), "Thursday");
  assert.equal(dayName("2026-01-17"), "Saturday");
  assert.equal(dayName(null), "");
});

test("the grid defaults to tomorrow, for planning ahead", () => {
  assert.equal(defaultDate(new Date(2026, 0, 15)), "2026-01-16");
  assert.equal(defaultDate(new Date(2026, 0, 31)), "2026-02-01", "month rollover");
  assert.equal(defaultDate(new Date(2026, 11, 31)), "2027-01-01", "year rollover");
});

test("a new associate row starts blank", () => {
  assert.deepEqual(emptyAssociate("JOHN"), {
    name: "JOHN", slots: {}, status: null,
    shiftStart: null, shiftEnd: null, shiftLabel: null,
  });
});

// ── absence ──────────────────────────────────────────────────────────────
//
// Marking someone absent must change the ARITHMETIC without destroying the
// plan: the cells stay (it has to be undoable) but stop counting as cover.

test("an absent associate contributes nothing to the staffing counts", () => {
  const { counts } = summarise([
    assoc({ name: "HERE", slots: { 0: "PICK" } }),
    assoc({ name: "OUT",  slots: { 0: "PICK" }, status: "absent" }),
  ]);
  assert.equal(counts.pickers[0], 1, "only the person actually on the floor counts");
});

test("marking absent does not erase the assigned cells", () => {
  // The undo path depends on this: the slots must survive so unmarking
  // restores the plan rather than leaving an empty row.
  const a = assoc({ name: "OUT", slots: { 0: "PICK" }, status: "absent" });
  summarise([a]);
  assert.deepEqual(a.slots, { 0: "PICK" }, "summarise must not mutate the roster");
});

test("a tardy associate still counts — only absence removes cover", () => {
  const { counts } = summarise([assoc({ slots: { 0: "PICK" }, status: "tardy" })]);
  assert.equal(counts.pickers[0], 1);
});

test("absent associates leave the fill percentage denominator", () => {
  // Both have an 8-slot shift; only one is here, and their slots are filled.
  const full = fillPercentage([
    assoc({ name: "HERE", slots: Object.fromEntries([...Array(8)].map((_, i) => [i, "PICK"])) }),
    assoc({ name: "OUT", slots: {}, status: "absent" }),
  ]);
  assert.equal(full, 100, "a fully-planned day must not read as half-empty because someone called in");
});

test("isAbsent is exact — no truthiness on other statuses", () => {
  assert.equal(isAbsent({ status: "absent" }), true);
  assert.equal(isAbsent({ status: "tardy" }), false);
  assert.equal(isAbsent({ status: null }), false);
  assert.equal(isAbsent({}), false);
  assert.equal(isAbsent(undefined), false);
});

// ── fractional coverage ──────────────────────────────────────────────────
//
// The reported bug: a :40 start counted as a WHOLE person for an hour they
// work 20 minutes of, inflating both the staffing line and the estimated
// picks derived from it. The old rule only ever string-matched ":30".

test("a :40 start counts as part of an hour, not all of it", () => {
  const a = assoc({ shiftStart: 0, shiftEnd: 8, shiftLabel: "5:40am-1:00pm" });
  assert.equal(slotCoverage(a, 0), 0.5, "20 of 60 minutes rounds to half");
  assert.equal(slotCoverage(a, 1), 1,   "6-7 is worked in full");
});

test("a late end fills its last whole hour and rounds the remainder", () => {
  // 2:10pm: the 1-2 hour is worked end to end, and the 10 minutes spilling
  // into 2-3 round to nothing. Quantising to halves means anything under 15
  // minutes reads as absent, which is the right answer for staffing.
  const a = assoc({ shiftStart: 0, shiftEnd: 10, shiftLabel: "5:00am-2:10pm" });
  assert.equal(slotCoverage(a, 8), 1, "1-2pm worked in full");
  assert.equal(slotCoverage(a, 9), 0, "10 minutes rounds away");
});

test("a :30 end gives its last slot a half", () => {
  const a = assoc({ shiftStart: 0, shiftEnd: 10, shiftLabel: "5:00am-2:30pm" });
  assert.equal(slotCoverage(a, 9), 0.5);
});

test("minutes past the half hour round up to a full slot", () => {
  // 50 of 60 minutes is a whole person for planning purposes.
  const a = assoc({ shiftStart: 0, shiftEnd: 4, shiftLabel: "5:10am-9:00am" });
  assert.equal(slotCoverage(a, 0), 1);
});

test("slots outside the shift are zero", () => {
  const a = assoc({ shiftStart: 2, shiftEnd: 5, shiftLabel: "7:00am-10:00am" });
  assert.equal(slotCoverage(a, 0), 0);
  assert.equal(slotCoverage(a, 5), 0);
});

test("an unreadable label falls back to whole slots rather than guessing", () => {
  const a = assoc({ shiftStart: 0, shiftEnd: 3, shiftLabel: null });
  assert.equal(slotCoverage(a, 0), 1);
  assert.equal(slotCoverage(a, 5), 0);
});

test("an overnight label falls back rather than inverting", () => {
  // 10pm-7am has no honest place on a 5am-10pm grid and is clamped upstream.
  const a = assoc({ shiftStart: 0, shiftEnd: 2, shiftLabel: "10:00pm-7:00am" });
  assert.equal(slotCoverage(a, 0), 1, "whole-slot fallback, not a negative overlap");
});

test("estimated picks follow the fractional headcount and stay whole", () => {
  const { estimatedPicks } = summarise([
    assoc({ shiftStart: 0, shiftEnd: 4, shiftLabel: "5:30-9:30", slots: { 0: "PICK" } }),
  ]);
  // Half a picker at 75/hr, rounded: a fractional pick count is false precision.
  assert.equal(estimatedPicks[0], 38);
  assert.ok(Number.isInteger(estimatedPicks[0]));
});
