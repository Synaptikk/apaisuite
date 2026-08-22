// modules/vizpick/lib/tests/dept_headers.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/dept_headers.test.mjs
//
// Tableau republished the VizPick workbook on 2026-08-22 and renamed two
// columns of the department breakout:
//
//   "Suggested Picks"           -> "Suggested Picks Seen"
//   "Suggested Picks Completed" -> "Suggested Picks Done"
//
// parseDeptBreakout looked both up by exact name, so its required-column guard
// rejected every export. Every store in the market failed, the Today crawl
// captured nothing, and — because a failed capture correctly leaves the stored
// snapshot alone — the tab kept showing valid-looking data frozen at the last
// successful pull. Nothing said "the source changed shape".
//
// The header row below is copied verbatim from the failing run's diagnostics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeptBreakout } from "../parse_vizpick_stores_csv.js";

const TAB = "\t";
const row = (...cells) => cells.join(TAB);

// Post-rename, with the real Total figures from the 2026-08-22 dashboard.
const RENAMED = [
  row("Dept", "Suggested Picks Seen", "Suggested Picks Done", "Pick %", "Total Picked",
      "Cases Seen", "Cases Expected", "Cases Seen %", "Overstock Exceptions",
      "Clearance Cases", "Modular Deleted Cases"),
  row("Total", "86", "54", "63%", "227", "980", "9,196", "11%", "22", "0", "0"),
  row("1", "5", "2", "40%", "2", "24", "162", "15%", "0", "0", "0"),
].join("\r\n");

// Pre-rename, as the workbook shipped until 2026-08-21.
const ORIGINAL = [
  row("Dept", "Suggested Picks", "Suggested Picks Completed", "Pick %", "Total Picked",
      "Cases Seen", "Cases Expected", "Cases Seen %", "Overstock Exceptions",
      "Clearance Cases", "Modular Deleted Cases"),
  row("Total", "739", "343", "46%", "452", "5,953", "10,816", "55%", "39", "76", "124"),
  row("2", "12", "5", "42%", "9", "104", "150", "69%", "3", "1", "2"),
].join("\r\n");

test("the renamed headers parse", () => {
  const r = parseDeptBreakout(RENAMED);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.total.suggestedPicks, 86);
  assert.equal(r.total.suggestedPicksCompleted, 54);
  assert.equal(r.total.totalPicked, 227);
  assert.equal(r.total.casesExpected, 9196);
});

test("the rename did not move the numerator — Pick % is still Done / Seen", () => {
  const { total } = parseDeptBreakout(RENAMED);
  // 54/86 = 62.8% -> 63%, which is what the dashboard shows. Worth pinning:
  // if a future rename swapped the two, every card would still render and
  // simply be wrong, which no amount of error handling would catch.
  assert.equal(
    Math.round((total.suggestedPicksCompleted / total.suggestedPicks) * 100),
    total.pickPct,
  );
});

test("the original headers still parse — a revert must not break us again", () => {
  const r = parseDeptBreakout(ORIGINAL);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.total.suggestedPicks, 739);
  assert.equal(r.total.suggestedPicksCompleted, 343);
});

test("both spellings agree on the shape they produce", () => {
  // The rest of the module must not be able to tell which spelling arrived.
  const a = Object.keys(parseDeptBreakout(RENAMED).total).sort();
  const b = Object.keys(parseDeptBreakout(ORIGINAL).total).sort();
  assert.deepEqual(a, b);
});

test("a genuinely missing column names itself rather than dumping the header row", () => {
  const bad = [
    row("Dept", "Pick %", "Cases Expected"),
    row("Total", "50%", "10"),
  ].join("\r\n");
  const r = parseDeptBreakout(bad);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing column\(s\)/);
  assert.match(r.reason, /Suggested Picks Seen/);
  // The header row is still included — knowing what DID arrive is how the
  // rename was eventually spotted.
  assert.match(r.reason, /got: Dept/);
});

test("an unrelated sheet is still rejected", () => {
  // The guard exists to catch a wrong sheet being handed in; loosening the
  // column lookup must not have loosened that.
  const wrong = [row("Store", "BU", "Region"), row("1", "A", "12")].join("\r\n");
  assert.equal(parseDeptBreakout(wrong).ok, false);
});
