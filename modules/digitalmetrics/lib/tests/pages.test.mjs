// modules/digitalmetrics/lib/tests/pages.test.mjs
//
// Page renderers are pure string functions, so they are testable without a DOM.
// These check the two things that actually break in production: crashing on
// empty state, and failing to escape a name.
//
// Run with: node --test modules/digitalmetrics/lib/tests/pages.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import * as dashboard     from "../pages/dashboard.js";
import * as comparison    from "../pages/comparison.js";
import * as classifyPage  from "../pages/classify.js";
import * as opportunities from "../pages/opportunities.js";
import * as leaderboard   from "../pages/leaderboard.js";
import * as faq           from "../pages/faq.js";
import { esc, nextSort, compareBy, flipDir } from "../pages/_shared.js";

const PAGES = { dashboard, comparison, classifyPage, opportunities, leaderboard, faq };

const assoc = (over = {}) => ({
  name: "JOHN SMITH", ftpr: 90, pick_rate: 100, nil_rate: 5, sub_rate: 5,
  hours: 40, picked_qty: 4000, nil_qty: 200, sub_qty: 200, exception_picks: 0,
  isExceptionsPicker: false, is5amAssociate: false,
  avgLateMinutes: 0, totalLateMinutes: 0, lateStartDays: 0,
  ...over,
});

const ctx = (over = {}) => ({
  associates: [assoc()],
  benchmarks: { ftpr: 90, nil_rate: 5, sub_rate: 5, pick_rate: 100,
                exc_ftpr: 50, exc_nil_rate: 20, exc_sub_rate: 20, exc_pick_rate: 40 },
  classifications: { "JOHN SMITH": "Digital" },
  adherence: {}, dates: ["2025-12-01"], rawData: [],
  store: "1458", week: "2025-11-29", ui: {},
  ...over,
});

test("every page renders a string with data", () => {
  for (const [name, page] of Object.entries(PAGES)) {
    const html = page.render(ctx());
    assert.equal(typeof html, "string", `${name} must return a string`);
    assert.ok(html.length > 0, `${name} rendered nothing`);
  }
});

test("every page renders without data instead of throwing", () => {
  // The empty state is what a user sees first, before picking a store.
  const blank = ctx({ associates: [], classifications: {}, dates: [], store: null, week: null });
  for (const [name, page] of Object.entries(PAGES)) {
    assert.doesNotThrow(() => page.render(blank), `${name} threw on empty state`);
  }
});

test("associate names are HTML-escaped everywhere they appear", () => {
  // A name is decrypted user data. The donor escaped by hand per call site;
  // here it must be impossible to forget.
  const nasty = `<img src=x onerror=alert(1)>`;
  const poisoned = ctx({
    associates: [assoc({ name: nasty })],
    classifications: { [nasty]: "Digital" },
  });

  for (const [name, page] of Object.entries(PAGES)) {
    const html = page.render(poisoned);
    assert.ok(!html.includes("<img src=x"), `${name} emitted a raw script vector`);
  }
});

test("esc neutralises every HTML metacharacter", () => {
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
});

test("dashboard shows the headline totals", () => {
  const html = dashboard.render(ctx());
  assert.match(html, /Total Associates/);
  assert.match(html, /4,000/, "pick total should be thousands-separated");
  assert.match(html, /90%/, "avg FTPR");
});

test("dashboard prompts for a store when none is selected", () => {
  assert.match(dashboard.render(ctx({ associates: [], store: null })), /Select a store/);
});

test("comparison renders a card per classification, including empty groups", () => {
  const html = comparison.render(ctx());
  for (const group of ["Digital", "Exceptions", "Store Help"]) {
    assert.ok(html.includes(group), `missing ${group} card`);
  }
  assert.match(html, /No associates in this group/, "empty groups say so");
});

test("opportunities lists only associates below benchmark", () => {
  const good = opportunities.render(ctx());
  assert.match(good, /No associates are below benchmark/);

  const bad = opportunities.render(ctx({ associates: [assoc({ ftpr: 50 })] }));
  assert.match(bad, /JOHN SMITH/);
  assert.match(bad, /FTPR: 50%/);
});

test("opportunities excludes Exceptions from the default group filter", () => {
  const html = opportunities.render(ctx({
    associates: [assoc({ name: "EXC", ftpr: 10, isExceptionsPicker: true })],
    classifications: { EXC: "Exceptions" },
  }));
  assert.ok(!html.includes(">EXC<"), "Exceptions should be off by default");
});

test("leaderboard discloses excluded low-volume outliers", () => {
  const html = leaderboard.render(ctx({
    associates: [
      assoc({ name: "FULL", picked_qty: 4000 }),
      assoc({ name: "ALSO", picked_qty: 4000 }),
      assoc({ name: "HALFDAY", picked_qty: 10 }),
    ],
    classifications: {},
  }));
  assert.match(html, /1 excluded as low-volume outliers/);
  assert.match(html, /HALFDAY/, "the excluded name must still be visible on request");
});

test("leaderboard sorts ascending for metrics where lower is better", () => {
  const html = leaderboard.render(ctx({
    associates: [assoc({ name: "HIGHNIL", nil_rate: 20 }), assoc({ name: "LOWNIL", nil_rate: 1 })],
    classifications: {},
    ui: { lbMetric: "nil_rate" },
  }));
  assert.ok(html.indexOf("LOWNIL") < html.indexOf("HIGHNIL"), "best nil rate ranks first");
});

// ── sortable headers ─────────────────────────────────────────────────────
//
// The headers are the only way to reach a sort the dropdown does not offer,
// and "show every metric" is the reason the boards are worth sorting at all.

test("leaderboard shows every metric column, not just the selected one", () => {
  const html = leaderboard.render(ctx({ ui: { lbMetric: "ftpr" } }));
  for (const label of ["FTPR", "Pick Rate", "Pick Qty", "Hours", "Nil Rate", "Sub Rate"]) {
    assert.match(html, new RegExp(">" + label + "<"), label + " column is missing");
  }
});

test("leaderboard headers carry a sort key and mark the active one", () => {
  const html = leaderboard.render(ctx({ ui: { lbMetric: "nil_rate" } }));
  assert.match(html, /data-dm-sort="nil_rate"/);
  assert.match(html, /aria-sort="ascending"/, "nil_rate is best-first ascending");
  // Rank has no order of its own.
  assert.doesNotMatch(html, /data-dm-sort="_rank"/);
});

test("lbRev inverts the ranking and the header arrow together", () => {
  const rows = { associates: [assoc({ name: "LOWNIL", nil_rate: 1 }), assoc({ name: "HIGHNIL", nil_rate: 20 })],
                 classifications: {} };
  const natural = leaderboard.render(ctx({ ...rows, ui: { lbMetric: "nil_rate" } }));
  const flipped = leaderboard.render(ctx({ ...rows, ui: { lbMetric: "nil_rate", lbRev: true } }));
  assert.ok(natural.indexOf("LOWNIL") < natural.indexOf("HIGHNIL"));
  assert.ok(flipped.indexOf("HIGHNIL") < flipped.indexOf("LOWNIL"), "reversed order");
  assert.match(flipped, /aria-sort="descending"/, "the arrow must follow the data");
});

test("leaderboard can sort by associate name without falling back to FTPR", () => {
  const html = leaderboard.render(ctx({
    associates: [assoc({ name: "ZOE" }), assoc({ name: "ADAM" })],
    classifications: {},
    ui: { lbMetric: "name" },
  }));
  assert.ok(html.indexOf("ADAM") < html.indexOf("ZOE"), "names sort A-Z");
});

test("opportunities exposes volume and lateness, and sorts by header", () => {
  const html = opportunities.render(ctx({
    associates: [assoc({ name: "BAD", ftpr: 40 })],
    ui: { oppSort: "ftpr" },
  }));
  assert.match(html, />Pick Qty</, "volume is needed to weigh a flag");
  assert.match(html, />Late</);
  assert.match(html, /data-dm-sort="ftpr"/);
  assert.match(html, /aria-sort="ascending"/, "worst FTPR first is ascending");
  assert.doesNotMatch(html, /data-dm-sort="issues"/, "a list of strings has no order");
});

test("opportunities Score header sorts by the overall ranking", () => {
  const html = opportunities.render(ctx({ associates: [assoc({ name: "BAD", ftpr: 40 })] }));
  assert.match(html, /data-dm-sort="overall"/);
});

test("opportunities sorts descriptive columns plainly instead of silently using Overall", () => {
  // picked_qty is not in SORTS. Before, it hit the unknown-key fallback and
  // re-sorted by Overall, so the header looked broken.
  const html = opportunities.render(ctx({
    associates: [assoc({ name: "SMALL", ftpr: 40, picked_qty: 500 }),
                 assoc({ name: "BIG", ftpr: 41, picked_qty: 9000 })],
    classifications: { SMALL: "Digital", BIG: "Digital" },
    ui: { oppSort: "picked_qty" },
  }));
  assert.ok(html.indexOf("BIG") < html.indexOf("SMALL"), "highest volume first");
});

test("classify shows a radio per category for each associate", () => {
  const html = classifyPage.render(ctx());
  for (const c of ["Digital", "Exceptions", "Store Help", "Unclassified"]) {
    assert.ok(html.includes(`value="${c}"`), `missing ${c} option`);
  }
  assert.match(html, /checked/, "current classification is pre-selected");
});

test("classify search and filter narrow the list", () => {
  const two = ctx({
    associates: [assoc({ name: "ALICE" }), assoc({ name: "BOB" })],
    classifications: { ALICE: "Digital", BOB: "Store Help" },
  });
  assert.ok(classifyPage.render({ ...two, ui: { classifySearch: "ALI" } }).includes("ALICE"));
  assert.ok(!classifyPage.render({ ...two, ui: { classifySearch: "ALI" } }).includes(">BOB<"));
  assert.ok(!classifyPage.render({ ...two, ui: { classifyFilter: "Store Help" } }).includes(">ALICE<"));
});

test("FAQ documents the metric definitions the other modules implement", () => {
  const html = faq.render();
  for (const term of ["FTPR", "Pick Adherence", "Late starts", "Week numbering"]) {
    assert.ok(html.includes(term), `FAQ missing ${term}`);
  }
  assert.match(html, /never stored in the database/, "FAQ should explain the name handling");
});

// ── nextSort ─────────────────────────────────────────────────────────────
//
// The header click handlers are a DOM event away from being testable, so the
// decision they make lives here instead. The failure this guards is a header
// that appears to do nothing: get the same-column branch wrong and clicking
// the active column re-selects it instead of flipping.

test("clicking a new column switches to it in its natural order", () => {
  assert.deepEqual(
    nextSort({ clicked: "ftpr", current: "nil_rate", rev: true, keyField: "lbMetric", revField: "lbRev" }),
    { lbMetric: "ftpr", lbRev: false });
});

test("clicking the active column flips instead of re-selecting it", () => {
  assert.deepEqual(
    nextSort({ clicked: "ftpr", current: "ftpr", rev: false, keyField: "lbMetric", revField: "lbRev" }),
    { lbRev: true });
  assert.deepEqual(
    nextSort({ clicked: "ftpr", current: "ftpr", rev: true, keyField: "lbMetric", revField: "lbRev" }),
    { lbRev: false }, "and flips back");
});

test("nextSort keys the patch by the caller's own fields", () => {
  // Both boards share the function but not their ui state field names.
  assert.deepEqual(
    nextSort({ clicked: "overall", current: "ftpr", rev: false, keyField: "oppSort", revField: "oppRev" }),
    { oppSort: "overall", oppRev: false });
});

test("flipDir only ever yields asc or desc", () => {
  assert.equal(flipDir("asc"), "desc");
  assert.equal(flipDir("desc"), "asc");
  assert.equal(flipDir(undefined), "asc", "an absent direction is treated as desc");
});

test("compareBy sorts numbers numerically, not as text", () => {
  const rows = [{ name: "A", v: 9 }, { name: "B", v: 100 }, { name: "C", v: 20 }];
  assert.deepEqual([...rows].sort(compareBy("v", "asc")).map((r) => r.v), [9, 20, 100]);
});

test("compareBy breaks ties by name so rows do not shuffle between renders", () => {
  const rows = [{ name: "ZOE", v: 5 }, { name: "ADAM", v: 5 }];
  assert.deepEqual([...rows].sort(compareBy("v", "desc")).map((r) => r.name), ["ADAM", "ZOE"]);
});

test("opportunities default groups track CLASSIFICATIONS instead of a stale list", () => {
  // Regression: the default named "Fashion" after it stopped being a
  // classification, so it filtered on a group nothing could match.
  const html = opportunities.render(ctx({ associates: [assoc({ name: "BAD", ftpr: 40 })] }));
  assert.match(html, /BAD/, "a Digital associate must survive the default filter");
  assert.doesNotMatch(html, /Fashion/, "no dead category anywhere on the page");
});
