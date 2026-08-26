// modules/digitalmetrics/lib/tests/paste.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseTask, parsePastedTasks, applyPaste, tasksToClipboard, TASKS,
} from "../data/paste.js";
import { TIME_SLOTS } from "../data/grid.js";

test("the task vocabulary comes from the grid's own shortcut table", () => {
  for (const t of ["PICK", "DISP", "STAGE", "PREP", "GMD", "IP", "EXC", "L", "B", "30"]) {
    assert.ok(TASKS.includes(t), t);
  }
});

test("task names are accepted in any case", () => {
  assert.equal(normaliseTask("PICK"), "PICK");
  assert.equal(normaliseTask("pick"), "PICK");
  assert.equal(normaliseTask("  Disp "), "DISP");
});

test("shortcut letters are accepted, so a column of 'p' pastes as PICK", () => {
  assert.equal(normaliseTask("p"), "PICK");
  assert.equal(normaliseTask("E"), "EXC");
  assert.equal(normaliseTask("3"), "30");
});

test("blank and spreadsheet filler clear the cell", () => {
  for (const v of ["", "   ", "-", "n/a", "NONE", "."]) {
    assert.equal(normaliseTask(v), "", JSON.stringify(v));
  }
});

test("an unrecognised value is undefined, not silently dropped in", () => {
  assert.equal(normaliseTask("LUNCHTIME"), undefined);
  assert.equal(normaliseTask("zzz"), undefined);
});

// ── parsePastedTasks ──────────────────────────────────────────────────────

test("tabs are columns and newlines are rows", () => {
  const { rows } = parsePastedTasks("PICK\tDISP\nSTAGE\tPREP");
  assert.deepEqual(rows, [["PICK", "DISP"], ["STAGE", "PREP"]]);
});

test("CRLF from Windows spreadsheets is handled", () => {
  const { rows } = parsePastedTasks("PICK\tDISP\r\nSTAGE\tPREP\r\n");
  assert.deepEqual(rows, [["PICK", "DISP"], ["STAGE", "PREP"]]);
});

test("short rows are padded with null, meaning 'leave alone'", () => {
  // A 1-wide row inside a 3-wide block must not clear the two columns it
  // never mentioned.
  const { rows } = parsePastedTasks("PICK\tDISP\tSTAGE\nPREP");
  assert.deepEqual(rows[1], ["PREP", null, null]);
});

test("unrecognised values are reported and leave their cell untouched", () => {
  const { rows, unrecognised } = parsePastedTasks("PICK\tWOMBAT");
  assert.deepEqual(rows, [["PICK", null]]);
  assert.deepEqual(unrecognised, ["WOMBAT"]);
});

test("empty clipboard yields nothing", () => {
  assert.deepEqual(parsePastedTasks("").rows, []);
  assert.deepEqual(parsePastedTasks(null).rows, []);
});

// ── applyPaste ────────────────────────────────────────────────────────────

const grid = () => [
  { name: "ADA", slots: {} },
  { name: "GRACE", slots: {} },
  { name: "ALAN", slots: {} },
];

test("a block fills right and down from the focused cell", () => {
  const { updates } = applyPaste(grid(), "ADA", 2,
    parsePastedTasks("PICK\tDISP\nSTAGE\tPREP").rows, TIME_SLOTS.length);
  assert.deepEqual(updates, [
    { name: "ADA",   slot: 2, task: "PICK" },
    { name: "ADA",   slot: 3, task: "DISP" },
    { name: "GRACE", slot: 2, task: "STAGE" },
    { name: "GRACE", slot: 3, task: "PREP" },
  ]);
});

test("paste follows VISIBLE row order, not alphabetical", () => {
  const rows = [{ name: "ZED", slots: {} }, { name: "ABE", slots: {} }];
  const { updates } = applyPaste(rows, "ZED", 0, parsePastedTasks("PICK\nDISP").rows, TIME_SLOTS.length);
  assert.equal(updates[1].name, "ABE");
});

test("nulls skip their cell entirely", () => {
  const { updates } = applyPaste(grid(), "ADA", 0,
    parsePastedTasks("PICK\tWOMBAT\tSTAGE").rows, TIME_SLOTS.length);
  assert.deepEqual(updates.map((u) => u.slot), [0, 2]);
});

test("an empty string CLEARS a cell — it is an edit, not a skip", () => {
  const { updates } = applyPaste(grid(), "ADA", 0, parsePastedTasks("PICK\t\tSTAGE").rows, TIME_SLOTS.length);
  assert.deepEqual(updates, [
    { name: "ADA", slot: 0, task: "PICK" },
    { name: "ADA", slot: 1, task: "" },
    { name: "ADA", slot: 2, task: "STAGE" },
  ]);
});

test("a paste wider than the grid stops at the edge and counts the loss", () => {
  const wide = parsePastedTasks(Array(TIME_SLOTS.length + 3).fill("PICK").join("\t")).rows;
  const { updates, skipped } = applyPaste(grid(), "ADA", 0, wide, TIME_SLOTS.length);
  assert.equal(updates.length, TIME_SLOTS.length);
  assert.equal(skipped, 3);
});

test("a paste taller than the grid stops rather than wrapping onto someone else", () => {
  const tall = parsePastedTasks("PICK\nPICK\nPICK\nPICK\nPICK").rows;
  const { updates, skipped } = applyPaste(grid(), "ADA", 0, tall, TIME_SLOTS.length);
  assert.equal(updates.length, 3);
  assert.equal(skipped, 2);
});

test("pasting onto a name not in the grid does nothing", () => {
  const { updates } = applyPaste(grid(), "NOBODY", 0, parsePastedTasks("PICK").rows, TIME_SLOTS.length);
  assert.deepEqual(updates, []);
});

test("copy output pastes back in unchanged", () => {
  const text = tasksToClipboard([["PICK", "DISP"], ["STAGE", ""]]);
  assert.deepEqual(parsePastedTasks(text).rows, [["PICK", "DISP"], ["STAGE", ""]]);
});

// ── selection range ───────────────────────────────────────────────────────

import { cellsInRange, inRange } from "../data/paste.js";

test("a range covers the rectangle between two corners", () => {
  const cells = cellsInRange(grid(), { name: "ADA", slot: 1 }, { name: "GRACE", slot: 2 });
  assert.deepEqual(cells, [
    { name: "ADA",   slot: 1 }, { name: "ADA",   slot: 2 },
    { name: "GRACE", slot: 1 }, { name: "GRACE", slot: 2 },
  ]);
});

test("dragging up or left works — corners are unordered", () => {
  const down = cellsInRange(grid(), { name: "ADA", slot: 1 }, { name: "ALAN", slot: 3 });
  const up   = cellsInRange(grid(), { name: "ALAN", slot: 3 }, { name: "ADA", slot: 1 });
  assert.deepEqual(up, down);
});

test("a single cell is a range of one", () => {
  assert.deepEqual(cellsInRange(grid(), { name: "ADA", slot: 0 }, { name: "ADA", slot: 0 }),
    [{ name: "ADA", slot: 0 }]);
});

test("a range whose row has left the grid is empty, not wrong", () => {
  // The roster reloads; a corner can vanish. Better to select nothing than to
  // silently shift the rectangle onto whoever took that row.
  assert.deepEqual(cellsInRange(grid(), { name: "GONE", slot: 0 }, { name: "ADA", slot: 1 }), []);
});

test("no selection means no cells", () => {
  assert.deepEqual(cellsInRange(grid(), null, null), []);
});

test("inRange agrees with cellsInRange", () => {
  const order = grid().map((a) => a.name);
  const anchor = { name: "ADA", slot: 1 };
  const head   = { name: "GRACE", slot: 2 };
  const inside = cellsInRange(grid(), anchor, head);
  for (const c of inside) assert.ok(inRange(order, anchor, head, c.name, c.slot), JSON.stringify(c));
  assert.ok(!inRange(order, anchor, head, "ALAN", 1), "row outside");
  assert.ok(!inRange(order, anchor, head, "ADA", 3), "slot outside");
});
