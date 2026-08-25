// modules/digitalmetrics/lib/tests/tableau.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/tableau.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePickDate, pivotAssociateData } from "../data/tableau.js";

test("four-digit years are folded to two", () => {
  // Downstream parses the year as YY and adds 2000; "2025" would become 4025
  // and drop every row out of its week.
  assert.equal(normalizePickDate("12/1/2025"), "12/1/25");
  assert.equal(normalizePickDate("1/3/26"), "1/3/26");
});

test("unrecognised date shapes pass through untouched", () => {
  assert.equal(normalizePickDate("not a date"), "not a date");
  assert.equal(normalizePickDate(null), null);
  assert.equal(normalizePickDate("12-01-25"), "12-01-25");
});

const melted = (measure, value, over = {}) => ({
  Associate: "JOHN SMITH", "Pick Date": "12/1/2025", "Store #": "1458",
  "Measure Names": measure, "Measure Values": value, ...over,
});

test("melted rows pivot to one wide row per associate per date", () => {
  const rows = pivotAssociateData([
    melted("Pick Rate", 85),
    melted("Pick Hours", 8),
    melted("Pick Rate", 90, { "Pick Date": "12/2/2025" }),
  ]);

  assert.equal(rows.length, 2);
  const first = rows.find((r) => r["Pick Date"] === "12/1/25");
  assert.equal(first["Pick Rate"], 85);
  assert.equal(first["Pick Hours"], 8);
  assert.equal(first.Associate, "JOHN SMITH");
});

test("numeric strings become numbers", () => {
  // data/metrics.js treats a non-number as zero, so string metrics would
  // total every column to nothing.
  const [row] = pivotAssociateData([melted("Pick Rate", "85.5"), melted("Picked As Req Qty", "1,200")]);
  assert.equal(row["Pick Rate"], 85.5);
  assert.equal(row["Picked As Req Qty"], 1200);
});

test("Tableau's string 'Null' is dropped, not stored", () => {
  const [row] = pivotAssociateData([melted("Pick Rate", "Null"), melted("Pick Hours", 8)]);
  assert.ok(!("Pick Rate" in row));
  assert.equal(row["Pick Hours"], 8);
});

test("either spelling of the first-scan column is accepted", () => {
  const [a] = pivotAssociateData([melted("Pick Rate", 1, { "MIN(First Scan)": "5:05 AM" })]);
  const [b] = pivotAssociateData([melted("Pick Rate", 1, { "Min. First Scan": "5:05 AM" })]);
  assert.equal(a["Min. First Scan"], "5:05 AM");
  assert.equal(b["Min. First Scan"], "5:05 AM");
});

test("rows without an associate or a date are skipped", () => {
  assert.deepEqual(pivotAssociateData([
    melted("Pick Rate", 1, { Associate: "" }),
    melted("Pick Rate", 1, { "Pick Date": null }),
  ]), []);
});

test("pivoting nothing yields nothing", () => {
  assert.deepEqual(pivotAssociateData([]), []);
  assert.deepEqual(pivotAssociateData(null), []);
});

test("the scraped shape feeds straight into the week splitter", async () => {
  const { splitByStoreWeek } = await import("../data/tableau.js");
  const { groups } = splitByStoreWeek(pivotAssociateData([melted("Pick Rate", 85)]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].store, "1458");
  assert.equal(groups[0].weekKey, "2025-11-29");
});
