import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestTasks } from "../data/suggest.js";

const row = (name, start, end, tasks = {}, extra = {}) => ({ name, shiftStart: start, shiftEnd: end, slots: tasks, ...extra });
const day = (date, associates) => ({ date, associates });

// 2026-09-24 is a Thursday; 09-17 is the Thursday before.
test("suggests the associate's usual task per hour, empty cells only", () => {
  const history = [
    day("2026-09-17", [row("KIRA JUNE", 0, 4, { 0: "PICK", 1: "PICK", 2: "DISP" })]),
    day("2026-09-21", [row("KIRA JUNE", 0, 4, { 0: "PICK", 1: "Pick", 2: "STAGE" })]),
    day("2026-09-22", [row("KIRA JUNE", 0, 4, { 0: "PICK", 1: "DISP", 2: "STAGE" })]),
  ];
  const today = [row("KIRA JUNE", 0, 4, { 0: "EXC" })];
  const s = suggestTasks(today, history, "2026-09-24");
  assert.equal(s["KIRA JUNE"][0], undefined);                    // already filled
  assert.deepEqual(s["KIRA JUNE"][1], { task: "PICK", confidence: 75 });  // Thursday counts double
  assert.equal(s["KIRA JUNE"][2], undefined);                    // DISP (Thursday, x2) ties STAGE x2: no habit
});

test("needs two real days; ignores future grids, other people, absent days", () => {
  const history = [
    day("2026-09-23", [row("KIRA JUNE", 0, 4, { 1: "PICK" })]),
    day("2026-09-24", [row("KIRA JUNE", 0, 4, { 1: "PICK" })]),                 // same day: ignored
    day("2026-09-25", [row("KIRA JUNE", 0, 4, { 1: "PICK" })]),                 // future: ignored
    day("2026-09-20", [row("KIRA SMITH", 0, 4, { 1: "PICK" })]),                // other person
    day("2026-09-19", [row("KIRA JUNE", 0, 4, { 1: "PICK" }, { status: "absent" })]),
  ];
  assert.deepEqual(suggestTasks([row("KIRA JUNE", 0, 4)], history, "2026-09-24"), {});
});

test("no suggestions outside the shift, for leadership, or for breaks", () => {
  const h = ["2026-09-21", "2026-09-22"].map((d) =>
    day(d, [row("A B", 0, 6, { 0: "B", 5: "PICK" }), row("C D", 0, 4, { 0: "PICK" }, { role: "TL" })]));
  const s = suggestTasks([row("A B", 0, 4), row("C D", 0, 4, {}, { role: "TL" })], h, "2026-09-24");
  assert.deepEqual(s, {});
});

test("a habitual lunch is suggested only inside today's lunch window", () => {
  const h = ["2026-09-21", "2026-09-22"].map((d) => day(d, [row("A B", 0, 9, { 1: "L", 4: "L" })]));
  const s = suggestTasks([row("A B", 0, 9)], h, "2026-09-24");
  assert.equal(s["A B"][1], undefined);       // slot 1 is inside the first 2 hours
  assert.deepEqual(s["A B"][4], { task: "L", confidence: 100 });
});
