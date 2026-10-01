// modules/cx/lib/tests/market.test.mjs
//
// The market table and the PDF's text handling. Both are pure, and both have
// the property that a wrong answer still looks like a table or a document — so
// the cases pinned here are the ones a glance would not catch.
//
//   node --test modules/cx/lib/tests/market.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { marketTable } from "../market.js";
import { ordinal, inlineRuns, markdownToPdf, cxDocDefinition } from "../report.js";

// ── fixtures ────────────────────────────────────────────────────────────

const week = (label, ty, ly) => ({ key: label, offset: 0, label, labelLong: `WM26 ${label}`, ty, ly });

const storeEntry = (buId, nps, npsLy, subTy = 4.5) => ({
  buId, ok: true,
  nps: { periods: [week("WK33", nps - 1, npsLy), week("WK34", nps, npsLy)] },
  subscores: { periods: [{
    label: "WK34", labelLong: "WM26 WK34",
    scores: {
      assocInteractions:    { ty: subTy, ly: 4.6 },
      checkoutSatisfaction: { ty: subTy, ly: 4.5 },
      productAvailability:  { ty: subTy, ly: 4.4 },
      scoPinpad:            { ty: subTy, ly: 4.5 },
      pickupDelivery:       { ty: subTy, ly: 4.7 },
      pickup:               { ty: subTy, ly: 4.8 },
      delivery:             { ty: subTy, ly: 4.6 },
      overallSatisfaction:  { ty: subTy, ly: 4.5 },
    },
  }] },
});

// ── marketTable ─────────────────────────────────────────────────────────

test("stores rank by NPS, highest first, and the home store is marked", () => {
  const t = marketTable({
    marketNbr: "120", homeStore: "1458", pulledAt: 1,
    market: storeEntry(120, 65, 60),
    stores: [storeEntry(1458, 58, 62), storeEntry(5151, 74, 72), storeEntry(669, 56, 55)],
  });
  assert.deepEqual(t.rows.map((r) => r.store), ["5151", "1458", "669"]);
  assert.deepEqual(t.rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(t.rows.find((r) => r.isHome).store, "1458");
  assert.equal(t.homeRank, 2);
});

test("vs-LY and vs-market are separate questions and can disagree", () => {
  // Up 6 on itself, still 7 behind the market. Reporting only one of these
  // would tell the opposite story depending which you picked.
  const t = marketTable({
    marketNbr: "120", homeStore: "1458", pulledAt: 1,
    market: storeEntry(120, 65, 60),
    stores: [storeEntry(1458, 58, 52)],
  });
  const home = t.rows[0];
  assert.equal(home.vsLy, 6);
  assert.equal(home.vsMarket, -7);
});

test("a store with no published NPS sorts last and is not ranked as a zero", () => {
  const blank = { buId: 999, ok: true, nps: { periods: [week("WK34", null, null)] }, subscores: { periods: [] } };
  const t = marketTable({
    marketNbr: "120", homeStore: "1458", pulledAt: 1,
    market: null,
    stores: [blank, storeEntry(1458, 58, 62)],
  });
  assert.equal(t.rows[0].store, "1458");
  assert.equal(t.rows[1].store, "999");
  assert.equal(t.rows[1].nps, null);
  assert.equal(t.rows[1].rank, null, "unranked, not last place");
  assert.equal(t.counts.scored, 1);
});

test("one failed store does not lose the others", () => {
  const t = marketTable({
    marketNbr: "120", homeStore: "1458", pulledAt: 1,
    market: null,
    stores: [{ buId: 658, ok: false, error: "HTTP 500" }, storeEntry(1458, 58, 62)],
  });
  assert.equal(t.rows.length, 2);
  const failed = t.rows.find((r) => r.store === "658");
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "HTTP 500");
  assert.equal(t.counts.scored, 1);
});

test("the market line is Hoops' own buType-5 figure, not a mean of the stores", () => {
  // Stores average 60; the published market figure is 65. The table must report
  // 65 — inventing an average here would quietly contradict the scorecard.
  const t = marketTable({
    marketNbr: "120", homeStore: "1458", pulledAt: 1,
    market: storeEntry(120, 65, 60),
    stores: [storeEntry(1458, 50, 50), storeEntry(5151, 70, 70)],
  });
  assert.equal(t.market.nps, 65);
  assert.equal(t.medianNps, 60, "median is offered separately as a sanity line");
});

test("medianNps is a median, not a mean", () => {
  const t = marketTable({
    marketNbr: "120", homeStore: null, pulledAt: 1, market: null,
    // A mean would be 47.5; the median is 55 and describes the stores better.
    stores: [storeEntry(1, 10, 10), storeEntry(2, 50, 50), storeEntry(3, 60, 60), storeEntry(4, 70, 70)],
  });
  assert.equal(t.medianNps, 55);
});

test("each store reports its OWN latest published week", () => {
  // A store that has not published this week must show its last real figure
  // rather than a null that reads as a collapse.
  const stale = {
    buId: 777, ok: true,
    nps: { periods: [week("WK32", 61, 60), week("WK33", null, null), week("WK34", null, null)] },
    subscores: { periods: [] },
  };
  const t = marketTable({ marketNbr: "120", homeStore: null, pulledAt: 1, market: null, stores: [stale] });
  assert.equal(t.rows[0].nps, 61);
  assert.equal(t.rows[0].period, "WK32");
});

test("an empty pull returns an empty table rather than throwing", () => {
  const t = marketTable({ marketNbr: "120", homeStore: null, pulledAt: 1, market: null, stores: [] });
  assert.deepEqual(t.rows, []);
  assert.equal(t.medianNps, null);
  assert.equal(t.homeRank, null);
});

// ── report.js ───────────────────────────────────────────────────────────

test("ordinal handles the teens, which the last-digit rule gets wrong", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(4), "4th");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(21), "21st");
  assert.equal(ordinal(112), "112th");
});

test("bold runs are split out and the surrounding text is kept", () => {
  assert.deepEqual(inlineRuns("plain **bold** tail"),
    [{ text: "plain " }, { text: "bold", bold: true }, { text: " tail" }]);
  assert.deepEqual(inlineRuns("no markup"), [{ text: "no markup" }]);
  assert.deepEqual(inlineRuns("**all**"), [{ text: "all", bold: true }]);
});

test("markdown headings and bullets become distinct pdfmake nodes", () => {
  const nodes = markdownToPdf("## Heading\n\n- first **item**\n- second\n\nA paragraph.");
  assert.equal(nodes.length, 4);
  assert.equal(nodes[0].style, "h3");
  assert.equal(nodes[0].text, "Heading");
  assert.equal(nodes[1].style, "bullet");
  assert.equal(nodes[3].style, "body");
});

test("an unrecognised markdown line falls through as a paragraph rather than vanishing", () => {
  const nodes = markdownToPdf("> a blockquote we do not handle");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].style, "body");
});

test("the document builds from a minimal model and from an empty one", () => {
  const empty = cxDocDefinition({ storeNbr: "1458", generatedAt: Date.now() });
  assert.ok(Array.isArray(empty.content) && empty.content.length >= 2, "title block always present");
  assert.equal(typeof empty.footer, "function");

  const full = cxDocDefinition({
    storeNbr: "1458",
    generatedAt: Date.now(),
    scores: {
      nps: { periods: [week("WK34", 58, 62)] },
      subscores: { periods: [{ label: "WK34", scores: { assocInteractions: { ty: 4.12, ly: 4.65 } } }] },
      subscoreDefs: [{ key: "assocInteractions", label: "Associate interactions", scope: "store" }],
    },
    market: marketTable({
      marketNbr: "120", homeStore: "1458", pulledAt: 1,
      market: storeEntry(120, 65, 60), stores: [storeEntry(1458, 58, 62)],
    }),
    analysis: {
      counts: { filtered: 7949, firstDay: "2025-09-26", lastDay: "2026-09-24" },
      ratings: { bands: { promoter: 5236, passive: 654, detractor: 1903 } },
      themes: {
        taggedCount: 3279,
        negative: [{ label: "Order accuracy", negative: 187, positive: 8, negativeShare: 0.96,
                     examples: { negative: [{ day: "2026-09-01", journey: "Scheduled Delivery", score: 1, text: "Items missing." }] } }],
        positive: [{ label: "Associates & service", positive: 1238, negative: 144 }],
      },
      movement: { windowDays: 28, movers: [
        { label: "Product quality", direction: "worse", priorRate: 2, recentRate: 3.8, deltaRate: 1.8, thin: false },
        { label: "Tipping", direction: "worse", priorRate: 0, recentRate: 0.5, deltaRate: 0.5, thin: true },
      ] },
    },
    narrative: { text: "## The short version\n\nNPS is **down**.", model: "claude-sonnet-5" },
  });
  const flat = JSON.stringify(full.content);
  assert.match(flat, /The market/);
  assert.match(flat, /This store/);
  assert.match(flat, /Order accuracy/);
  assert.match(flat, /Product quality/);
  assert.doesNotMatch(flat, /Tipping/, "thin movers are excluded from the report");
  assert.match(flat, /The short version/);

  // Section order is a deliberate choice, so it is pinned: the written read
  // leads as the summary, then the market, this store's detail and the comment
  // breakdown it was drawn from.
  const headings = full.content
    .filter((n) => n?.style === "h2" && typeof n.text === "string")
    .map((n) => n.text);
  assert.deepEqual(headings, ["The read", "The market", "This store", "What the comments say"]);
});

test("nothing is forced onto a fresh page — that is what left the half-empty pages", () => {
  const doc = cxDocDefinition({
    storeNbr: "1458",
    generatedAt: Date.now(),
    scores: {
      nps: { periods: [week("WK34", 58, 62)] },
      subscores: { periods: [{ label: "WK34", scores: { assocInteractions: { ty: 4.12, ly: 4.65 } } }] },
      subscoreDefs: [{ key: "assocInteractions", label: "Associate interactions", scope: "store" }],
    },
    market: marketTable({
      marketNbr: "120", homeStore: "1458", pulledAt: 1,
      market: storeEntry(120, 65, 60), stores: [storeEntry(1458, 58, 62)],
    }),
    narrative: { text: "## The short version\n\nNPS is **down**." },
  });
  assert.doesNotMatch(JSON.stringify(doc.content), /pageBreak/);
  // Tables are kept whole instead, which is the part that actually needs it.
  const tables = doc.content.filter((n) => n?.table);
  assert.ok(tables.length > 0);
  assert.ok(tables.every((t) => t.unbreakable === true), "every table stays on one page");
});

test("a report with no market data still leads with the store", () => {
  const doc = cxDocDefinition({
    storeNbr: "1458",
    generatedAt: Date.now(),
    scores: {
      nps: { periods: [week("WK34", 58, 62)] },
      subscores: { periods: [{ label: "WK34", scores: { assocInteractions: { ty: 4.12, ly: 4.65 } } }] },
      subscoreDefs: [{ key: "assocInteractions", label: "Associate interactions", scope: "store" }],
    },
  });
  const headings = doc.content.filter((n) => n?.style === "h2" && typeof n.text === "string").map((n) => n.text);
  assert.deepEqual(headings, ["This store"]);
});
