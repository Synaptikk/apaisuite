// modules/digitalmetrics/lib/tests/associates.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/associates.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchAssociates, dailyBreakdown, taskPatterns, associateReport,
} from "../data/associates.js";
import * as page from "../pages/associates.js";

const names = (list) => list.map((a) => a.name);
const A = (name) => ({ name });

test("whole-name prefix ranks above word prefix, which ranks above contains", () => {
  const found = searchAssociates(
    [A("GOLDSMITH ANA"), A("JOHN SMITH"), A("SMITH JOHN")], "SMI");
  assert.deepEqual(names(found), ["SMITH JOHN", "JOHN SMITH", "GOLDSMITH ANA"]);
});

test("equal-tier matches are alphabetical", () => {
  assert.deepEqual(names(searchAssociates([A("SAM B"), A("SAM A")], "SAM")), ["SAM A", "SAM B"]);
});

test("search is case-insensitive and trims", () => {
  assert.equal(searchAssociates([A("JOHN SMITH")], "  john ").length, 1);
});

test("an empty query returns nothing rather than everything", () => {
  assert.deepEqual(searchAssociates([A("A"), A("B")], ""), []);
  assert.deepEqual(searchAssociates([A("A")], "   "), []);
});

test("results are capped", () => {
  const many = Array.from({ length: 50 }, (_, i) => A(`SAM ${i}`));
  assert.equal(searchAssociates(many, "SAM").length, 10);
  assert.equal(searchAssociates(many, "SAM", { limit: 3 }).length, 3);
});

// ── daily breakdown ──────────────────────────────────────────────────────
const row = (over = {}) => ({
  Associate: "JOHN SMITH", "Pick Date": "12/01/25", "Pick Hours": 8, "Pick Rate": 100,
  "FTP Expected": 100, "FTP Actual": 90, "Picked As Req Qty": 100,
  "Nil Pick Qty": 5, "Substitution Qty": 10,
  "Exception Qty Req to Pick": 0, "Exception Picked As Req Qty": 0,
  "Exception Nil Pick Qty": 0, "Exception Substitution Qty": 0, ...over,
});

test("daily breakdown covers only the named associate, newest first", () => {
  const daily = dailyBreakdown([
    row({ "Pick Date": "12/01/25" }),
    row({ "Pick Date": "12/03/25" }),
    row({ Associate: "SOMEONE ELSE", "Pick Date": "12/02/25" }),
  ], "JOHN SMITH");
  assert.deepEqual(daily.map((d) => d.date), ["12/03/25", "12/01/25"]);
});

test("daily rows fold exception work into the rates", () => {
  const [d] = dailyBreakdown([row({
    "FTP Expected": 100, "FTP Actual": 80,
    "Exception Qty Req to Pick": 100, "Exception Picked As Req Qty": 100,
  })], "JOHN SMITH");
  assert.equal(d.ftpr, 90);
  assert.equal(d.picked, 200);
});

test("daily breakdown inherits sparse dates and matches case-insensitively", () => {
  const daily = dailyBreakdown(
    [row({ "Pick Date": "12/01/25" }), row({ Associate: "john smith", "Pick Date": undefined })],
    "JOHN SMITH");
  assert.equal(daily.length, 2);
  assert.ok(daily.every((d) => d.date === "12/01/25"));
});

// ── task patterns ────────────────────────────────────────────────────────
const day = (name, slots) => ({ associates: [{ name, slots }] });

test("patterns rank tasks per slot with a confidence share", () => {
  const p = taskPatterns([
    day("JOHN SMITH", { 0: "Pick" }),
    day("JOHN SMITH", { 0: "Pick" }),
    day("JOHN SMITH", { 0: "Disp" }),
  ], "JOHN SMITH");

  assert.equal(p.totalDays, 3);
  assert.equal(p.slots["0"][0].task, "PICK");
  assert.equal(p.slots["0"][0].confidence, 67);
  assert.equal(p.slots["0"][1].task, "DISP");
});

test("patterns fall back to a first-name match", () => {
  // Rosters are hand-typed and often hold only a first name.
  const p = taskPatterns([day("JOHN", { 0: "Pick" })], "JOHN SMITH");
  assert.equal(p.totalDays, 1);
  assert.equal(p.slots["0"][0].task, "PICK");
});

test("patterns ignore other people and blank slots", () => {
  const p = taskPatterns([
    day("SOMEONE ELSE", { 0: "Pick" }),
    day("JOHN SMITH", { 0: "", 1: "  ", 2: "Stage" }),
  ], "JOHN SMITH");
  assert.equal(p.totalDays, 1);
  assert.deepEqual(Object.keys(p.slots), ["2"]);
});

test("patterns over no data are empty, not a crash", () => {
  assert.deepEqual(taskPatterns([], "X"), { totalDays: 0, slots: {} });
  assert.deepEqual(taskPatterns(null, "X"), { totalDays: 0, slots: {} });
  assert.deepEqual(taskPatterns([{}, { associates: null }], "X"), { totalDays: 0, slots: {} });
});

// ── report + page ────────────────────────────────────────────────────────
test("the report assembles summary, classification and adherence", () => {
  const r = associateReport("JOHN SMITH", {
    associates: [{ name: "JOHN SMITH", ftpr: 90 }],
    rawData: [row()],
    classifications: { "JOHN SMITH": "Digital" },
    adherence: { "JOHN SMITH": { adherence: 80 } },
  });
  assert.equal(r.summary.ftpr, 90);
  assert.equal(r.classification, "Digital");
  assert.equal(r.adherence.adherence, 80);
  assert.equal(r.daily.length, 1);
});

test("an associate with no metrics reports Unclassified rather than throwing", () => {
  const r = associateReport("GHOST", { associates: [], rawData: [] });
  assert.equal(r.summary, null);
  assert.equal(r.classification, "Unclassified");
});

test("the page renders search, report and empty states", () => {
  const ctx = {
    associates: [{ name: "JOHN SMITH", ftpr: 90, pick_rate: 100, hours: 40,
                   picked_qty: 4000, nil_rate: 5, sub_rate: 5 }],
    rawData: [row()], classifications: { "JOHN SMITH": "Digital" }, adherence: {},
    ui: {},
  };
  assert.match(page.render(ctx), /Find an associate/);
  assert.match(page.render({ ...ctx, ui: { assocSearch: "JOH" } }), /JOHN SMITH/);
  assert.match(page.render({ ...ctx, ui: { assocSelected: "JOHN SMITH" } }), /Daily Breakdown/);
  assert.match(page.render({ ...ctx, associates: [] }), /Select a store/);
});

test("the page escapes names in both the suggestion list and the report", () => {
  const nasty = "<img src=x onerror=1>";
  const ctx = {
    associates: [{ name: nasty, ftpr: 0, pick_rate: 0, hours: 0, picked_qty: 0,
                   nil_rate: 0, sub_rate: 0 }],
    rawData: [], classifications: {}, adherence: {},
    ui: { assocSearch: "img", assocSelected: nasty },
  };
  assert.ok(!page.render(ctx).includes("<img src=x"));
});
