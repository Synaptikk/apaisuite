// modules/digitalmetrics/lib/tests/import.test.mjs
//
// Excel ingest: value coercion, the Associate By Day export, and the hand-kept
// Daily Board workbook.
//
// Run with: node --test modules/digitalmetrics/lib/tests/import.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { coerce, rowsToObjects } from "../data/xlsx.js";
import { parseDayHeader, sheetToDay, parseDailyBoard } from "../data/daily_board.js";
import { parseXlsxAllSheets } from "../../vendor/xlsx_min.js";
import { readFileSync, existsSync } from "node:fs";

// ── coercion ─────────────────────────────────────────────────────────────
test("numeric cells become numbers, because zero-typed metrics total to zero", () => {
  assert.equal(coerce("8.5", "Pick Hours"), 8.5);
  assert.equal(coerce("1,234", "Picked As Req Qty"), 1234);
  assert.equal(coerce("-3", "Ovrd Qty"), -3);
});

test("date and name columns stay strings even when they look numeric", () => {
  assert.equal(coerce("12/01/25", "Pick Date"), "12/01/25");
  assert.equal(coerce("1458", "Store #"), "1458");
  assert.equal(coerce("12/6/25 9:08 AM", "Min. First Scan"), "12/6/25 9:08 AM");
});

test("blank cells are dropped rather than becoming zero", () => {
  // A blank hour is "no data", not "worked zero hours".
  assert.equal(coerce("", "Pick Hours"), undefined);
  assert.equal(coerce("   ", "Pick Hours"), undefined);
  assert.equal(coerce(null, "Pick Hours"), undefined);
});

test("non-numeric text survives unchanged", () => {
  assert.equal(coerce("N/A", "Pick Rate"), "N/A");
});

// ── Associate By Day ─────────────────────────────────────────────────────
test("the header row is found by content, not position", () => {
  // The export carries title lines above the table.
  const { headers, records } = rowsToObjects([
    ["Associate By Day Report"], [""],
    ["Associate", "Pick Hours"],
    ["JOHN SMITH", "8"],
  ]);
  assert.deepEqual(headers, ["Associate", "Pick Hours"]);
  assert.equal(records[0]["Pick Hours"], 8);
});

test("a sheet with no Associate column yields nothing rather than garbage", () => {
  assert.deepEqual(rowsToObjects([["Foo", "Bar"], ["1", "2"]]), { headers: [], records: [] });
  assert.deepEqual(rowsToObjects([]), { headers: [], records: [] });
});

test("entirely blank rows are skipped", () => {
  const { records } = rowsToObjects([["Associate", "Pick Hours"], ["", ""], ["A", "8"]]);
  assert.equal(records.length, 1);
});

// ── Daily Board ──────────────────────────────────────────────────────────
test("day headers parse two-digit years", () => {
  assert.equal(parseDayHeader("SATURDAY 1/3/26"), "2026-01-03");
  assert.equal(parseDayHeader("MONDAY 12/29/25"), "2025-12-29");
  assert.equal(parseDayHeader("not a day"), null);
  assert.equal(parseDayHeader(undefined), null);
});

const board = (over = []) => ([
  ["SATURDAY 1/3/26"],
  ["Pickers", "14", "15"],
  ["Associate", "5-6", "6-7", "7-8"],
  ...over,
]);

test("a sheet becomes a day document with slots keyed by column label", () => {
  const day = sheetToDay(board([["ZEPHYRA", "PICK", "PICK", "GMD"]]));
  assert.equal(day.date, "2026-01-03");
  assert.deepEqual(day.associates[0].slots, { 0: "PICK", 1: "PICK", 2: "GMD" });
});

test("slots map by column LABEL, so a re-ordered board still imports correctly", () => {
  const day = sheetToDay([
    ["SATURDAY 1/3/26"],
    ["Associate", "7-8", "5-6"],
    ["A", "GMD", "PICK"],
  ]);
  assert.deepEqual(day.associates[0].slots, { 2: "GMD", 0: "PICK" });
});

test("the shift window is inferred from the filled cells", () => {
  // The board records no shift times; without this, adherence would charge
  // every associate for the whole 17-hour day.
  const day = sheetToDay([
    ["SATURDAY 1/3/26"],
    ["Associate", "5-6", "6-7", "7-8"],
    ["A", "", "PICK", "PICK"],
  ]);
  assert.equal(day.associates[0].shiftStart, 1);
  assert.equal(day.associates[0].shiftEnd, 3);
});

test("template rows with a name but no tasks are not imported as workers", () => {
  const day = sheetToDay(board([["ZORA", "", "", ""], ["REAL", "PICK", "", ""]]));
  assert.deepEqual(day.associates.map((a) => a.name), ["REAL"]);
});

test("sheets that are not day boards return null", () => {
  assert.equal(sheetToDay([["Notes"], ["nothing here"]]), null);
  assert.equal(sheetToDay([]), null);
  assert.equal(sheetToDay(null), null);
  assert.equal(sheetToDay([["SATURDAY 1/3/26"], ["no header row"]]), null);
});

// ── against the real workbook ────────────────────────────────────────────
const FIXTURE = "/Users/shanesmith/Digital Metrics/historical/Daily Board 2 (2).xlsx";

test("every worksheet is read, not just the first", { skip: !existsSync(FIXTURE) }, async () => {
  // Reading only sheet1 would import one day of a week and look successful.
  const res = await parseXlsxAllSheets(new Uint8Array(readFileSync(FIXTURE)));
  assert.ok(res.ok);
  assert.ok(res.sheets.length > 1, `expected several sheets, got ${res.sheets.length}`);
});

test("the real Daily Board workbook imports a full week", { skip: !existsSync(FIXTURE) }, async () => {
  const res = await parseDailyBoard(new Uint8Array(readFileSync(FIXTURE)));
  assert.ok(res.ok, res.reason);
  assert.equal(res.days.length, 7, "a week of day boards");
  assert.ok(res.skippedSheets > 0, "scratch sheets are skipped, not failed on");

  assert.deepEqual([...res.days].sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.date),
                   res.days.map((d) => d.date), "days come back in date order");

  for (const day of res.days) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(day.associates.length > 10, `${day.date} looks empty`);
    for (const a of day.associates) {
      assert.ok(a.name && a.name === a.name.toUpperCase(), "names are normalised");
      assert.ok(Object.keys(a.slots).length > 0);
      assert.ok(a.shiftEnd > a.shiftStart);
    }
  }
});
