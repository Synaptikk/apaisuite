// modules/vizpick/lib/tests/toolbar_suppressed.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/toolbar_suppressed.test.mjs
//
// A tab opened with `:toolbar=n` renders the viz perfectly and has no toolbar.
// The Today capture drives Tableau through the toolbar's Download button, so
// adopting such a tab means waitForVizReady polls for a button that will never
// exist, burns its full 120s budget, and reports SLOW_RENDER — whose message
// ends "retrying often works". It cannot work. With three lanes that is six
// wasted minutes per crawl and a Today tab frozen at the last good pull.
//
// The url below is copied VERBATIM from the failure record of a live crawl on
// 2026-08-24 (market 120, store 1458): hasStoreParam true, hasToolbar false.
// MetricShot opens exactly this url on this view
// (modules/metricshot/data/defaults.js).
//
// The regexes are duplicated here rather than exported from the capture module:
// importing it pulls in chrome.* at module scope, which does not exist in node.
// They must stay in sync with vizpick_today_tableau.js — that is what the
// "matches the source" test below is for.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../sources/vizpick_today_tableau.js", import.meta.url), "utf8");

const TOOLBAR_SUPPRESSED = /[?&](?::|%3A)toolbar=n\b/i;
const VIEW_FRAGMENT = /\/views\/VizPick\/VizPickDetails(?:$|[?#])/i;

const OBSERVED_METRICSHOT_TAB =
  "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?%3Aembed=y&%3Atoolbar=n#10";

test("the regexes here match the ones the capture actually uses", () => {
  // These are copies; if the source changes shape this test is the tripwire.
  assert.ok(SRC.includes("const TOOLBAR_SUPPRESSED = /[?&](?::|%3A)toolbar=n\\b/i;"));
  assert.ok(SRC.includes("const VIEW_FRAGMENT = /\\/views\\/VizPick\\/VizPickDetails(?:$|[?#])/i;"));
});

test("the observed MetricShot tab is recognised as toolbar-suppressed", () => {
  assert.ok(VIEW_FRAGMENT.test(OBSERVED_METRICSHOT_TAB), "it IS the Details view");
  assert.ok(TOOLBAR_SUPPRESSED.test(OBSERVED_METRICSHOT_TAB), "and it must be rejected");
});

test("both the encoded and the plain colon form are caught", () => {
  const base = "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails";
  assert.ok(TOOLBAR_SUPPRESSED.test(`${base}?:embed=y&:toolbar=n`));
  assert.ok(TOOLBAR_SUPPRESSED.test(`${base}?%3Aembed=y&%3Atoolbar=n`));
  assert.ok(TOOLBAR_SUPPRESSED.test(`${base}?:toolbar=n`), "first param, not just later ones");
  assert.ok(TOOLBAR_SUPPRESSED.test(`${base}?:TOOLBAR=N`), "case-insensitive");
});

test("a drivable tab is NOT rejected", () => {
  const ok = [
    "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1",
    "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self",
    "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?%3Aembed=y",
  ];
  for (const u of ok) assert.equal(TOOLBAR_SUPPRESSED.test(u), false, u);
});

test("`toolbar=n` without the Tableau colon prefix is not a match", () => {
  // Tableau's view options are all colon-prefixed. A bare `toolbar=n` is some
  // other app's parameter and must not cause us to discard a usable tab.
  const u = "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?toolbar=n";
  assert.equal(TOOLBAR_SUPPRESSED.test(u), false);
});

test("the url is re-checked at the moment of use, not only at query time", () => {
  // The original guard filtered chrome.tabs.query results. That result is a
  // snapshot: a tab still loading reports its PRE-REDIRECT url, so a
  // :toolbar=n tab passed the filter and was adopted anyway. The fix re-reads
  // the tab before committing to it.
  assert.ok(SRC.includes("async function isToolbarSuppressed(tabId)"),
    "the re-check helper must exist");
  assert.ok(SRC.includes("if (!(await isToolbarSuppressed(live.id)))"),
    "findOrOpenReportTab must re-check before adopting");
});

test("suppression is detected from the DOM, not from the url", () => {
  // The url is NOT reliable here and this is the second version of this fix.
  // chrome.tabs.get can still report a tab's pre-redirect url after its
  // document has settled, so a url check let the MetricShot tab through and
  // the crawl burned the full 120s budget anyway — observed live twice.
  // The Store parameter box being present proves the viz rendered; a toolbar
  // still missing after that is missing by design.
  assert.ok(SRC.includes("async function waitForVizReadyOrSuppressed"),
    "the DOM-based wait must exist");
  assert.ok(SRC.includes('return "suppressed";'),
    "it must be able to report suppression distinctly from a timeout");
  assert.ok(SRC.includes('if (ready === "suppressed")'),
    "prepareTab must act on it");
});

test("the grace period is shorter than the render budget it exists to avoid", () => {
  // A grace longer than VIZ_READY_WAIT_MS would never fire, leaving the 120s
  // stall in place — the whole point of the check.
  const grace = /const TOOLBAR_GRACE_MS = ([\d_]+);/.exec(SRC);
  const budget = /const VIZ_READY_WAIT_MS = ([\d_]+);/.exec(SRC);
  assert.ok(grace && budget, "both constants must be declared");
  const g = Number(grace[1].replace(/_/g, ""));
  const b = Number(budget[1].replace(/_/g, ""));
  assert.ok(g < b, `grace ${g}ms must be under the ${b}ms budget`);
});

test("this failure is classified NO_TOOLBAR, never SLOW_RENDER", () => {
  // SLOW_RENDER's message ends "retrying often works", which is actively
  // misleading here — the tab will never grow a toolbar.
  assert.ok(SRC.includes('errorClass = "NO_TOOLBAR";'));
  const noToolbar = SRC.indexOf('errorClass = "NO_TOOLBAR";');
  const slowRender = SRC.indexOf('errorClass = "SLOW_RENDER";');
  assert.ok(noToolbar < slowRender, "NO_TOOLBAR must be tested before SLOW_RENDER");
});
