// modules/digitalmetrics/lib/tests/parse.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/parse.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePickDate, normalizeStore, forwardFill, splitByStoreWeek } from "../data/parse.js";

test("MM/DD/YY strings parse as local dates", () => {
  const d = parsePickDate("12/01/25");
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 11);
  assert.equal(d.getDate(), 1);
});

test("date-typed cells are accepted, not dropped", () => {
  // Regression: the donor only accepted strings, so SheetJS date cells fell
  // out of every group without warning.
  const d = parsePickDate(new Date(2025, 11, 1, 13, 45));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getDate(), 1);
});

test("unparseable dates return null rather than an Invalid Date", () => {
  assert.equal(parsePickDate("not a date"), null);
  assert.equal(parsePickDate(undefined), null);
  assert.equal(parsePickDate("12/01"), null);
});

test("store numbers normalise to bare strings", () => {
  assert.equal(normalizeStore(1458), "1458");
  assert.equal(normalizeStore("1458"), "1458");
  assert.equal(normalizeStore(1458.0), "1458");
  assert.equal(normalizeStore(""), null);
  assert.equal(normalizeStore(null), null);
});

test("sparse date and store columns forward-fill", () => {
  const filled = forwardFill([
    { "Store #": 1458, "Pick Date": "12/01/25", Associate: "A" },
    { Associate: "B" },
    { Associate: "C" },
    { "Pick Date": "12/02/25", Associate: "D" },
  ]);
  assert.deepEqual(filled.map((r) => r._store), ["1458", "1458", "1458", "1458"]);
  assert.equal(filled[2]._date.getDate(), 1);
  assert.equal(filled[3]._date.getDate(), 2);
});

test("one upload splits into a document per store and per week", () => {
  const { groups, skipped } = splitByStoreWeek([
    { "Store #": 1458, "Pick Date": "12/01/25", Associate: "A" },  // wk 11-29
    { Associate: "B" },
    { "Pick Date": "12/08/25", Associate: "C" },                   // wk 12-06
    { "Store #": 2000, "Pick Date": "12/01/25", Associate: "D" },  // other store
  ], { fileName: "Associate By Day.xlsx", uploadDate: "2026-01-01T00:00:00Z" });

  assert.equal(skipped, 0);
  const ids = groups.map((g) => `${g.store}/${g.weekKey}`).sort();
  assert.deepEqual(ids, ["1458/2025-11-29", "1458/2025-12-06", "2000/2025-11-29"]);

  const first = groups.find((g) => g.weekKey === "2025-11-29" && g.store === "1458");
  assert.equal(first.doc.rawData.length, 2);
  assert.equal(first.doc.weekStart, "2025-11-29");
  assert.equal(first.doc.fileName, "Associate By Day.xlsx");
});

test("internal fill markers never reach the saved document", () => {
  const { groups } = splitByStoreWeek([{ "Store #": 1, "Pick Date": "12/01/25", Associate: "A" }]);
  const row = groups[0].doc.rawData[0];
  assert.ok(!("_date" in row) && !("_store" in row));
  assert.equal(row.Associate, "A");
});

test("rows with no resolvable store or date are counted, not silently dropped", () => {
  const { groups, skipped } = splitByStoreWeek([
    { Associate: "orphan" },                                       // no store yet
    { "Store #": 1458, "Pick Date": "12/01/25", Associate: "A" },
  ]);
  assert.equal(skipped, 1);
  assert.equal(groups.length, 1);
});
