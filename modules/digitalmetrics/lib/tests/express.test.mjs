// modules/digitalmetrics/lib/tests/express.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/express.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOverview, isoFromPickDate, expressForLabel, mergeWeekDoc,
} from "../data/express.js";
import { buildExpressUrl, FULFILLMENT_TYPE } from "../sources/tableau_express.js";
import { dailyPicks, distribution } from "../data/insights.js";
import * as insightsPage from "../pages/insights.js";

// ── parseOverview ────────────────────────────────────────────────────────

const overviewRow = (measure, value, store = "1458") => ({
  BU: "SOUTHEAST BU", REGION: "12", MARKET: "120", STORE: store,
  "Measure Names": measure, "Measure Values": value,
});

test("parseOverview picks ORDERS, UNITS and SALES out of the melted rows", () => {
  const out = parseOverview([
    overviewRow("FTPR", "0.91"),
    overviewRow("ORDERS", "33.00"),
    overviewRow("UNITS", "1,197.00"),
    overviewRow("SALES", "3,074.11"),
  ], { store: "1458" });
  assert.deepEqual(out, { orders: 33, units: 1197, sales: 3074.11 });
});

test("parseOverview treats Tableau's \"Null\" as zero and ignores other stores", () => {
  const out = parseOverview([
    overviewRow("ORDERS", "Null"),
    overviewRow("UNITS", "Null"),
    overviewRow("ORDERS", "99.00", "5151"),
  ], { store: "1458" });
  assert.deepEqual(out, { orders: 0, units: 0, sales: 0 });
});

test("parseOverview without a store keeps every row", () => {
  const out = parseOverview([overviewRow("ORDERS", "5"), overviewRow("ORDERS", "7", "5151")]);
  assert.equal(out.orders, 12);
});

// ── date bridging ────────────────────────────────────────────────────────

test("isoFromPickDate folds both Pick Date spellings to ISO", () => {
  assert.equal(isoFromPickDate("9/14/26"), "2026-09-14");
  assert.equal(isoFromPickDate("9/4/2026"), "2026-09-04");
  assert.equal(isoFromPickDate("nope"), null);
});

test("expressForLabel finds the day by its Pick Date label", () => {
  const express = { "2026-09-14": { orders: 33, units: 589 } };
  assert.deepEqual(expressForLabel(express, "9/14/26"), { orders: 33, units: 589 });
  assert.equal(expressForLabel(express, "9/13/26"), null);
  assert.equal(expressForLabel(null, "9/14/26"), null);
});

// ── buildExpressUrl ──────────────────────────────────────────────────────

test("buildExpressUrl satisfies the week → market → store cascade for one day", () => {
  const url = buildExpressUrl("1458", "120", "2026-09-14");
  assert.match(url, /MetricOverviewandHourly\?/);
  assert.match(url, /WM_WEEK=202633/, "the fiscal week that contains the date");
  assert.match(url, /MARKET=120/);
  assert.match(url, /STORE=1458/);
  assert.match(url, new RegExp(`FULFMT_TYPE=${encodeURIComponent(FULFILLMENT_TYPE)}`));
  assert.match(url, /RPT_DT=2026-09-14/);
  assert.doesNotMatch(url, /\+/, "spaces must be %20, not +");
});

test("buildExpressUrl can leave the fulfillment type unfiltered for the quiet-day check", () => {
  const url = buildExpressUrl("1458", "120", "2026-09-14", { fulfillmentType: null });
  assert.doesNotMatch(url, /FULFMT_TYPE/);
  assert.match(url, /STORE=1458/);
  assert.match(url, /RPT_DT=2026-09-14/);
});

test("buildExpressUrl refuses to build an unscoped view", () => {
  assert.throws(() => buildExpressUrl("1458", null, "2026-09-14"), /no market/);
  assert.throws(() => buildExpressUrl("1458", "120", "garbage"), /bad date/);
});

// ── mergeWeekDoc ─────────────────────────────────────────────────────────

const row = (name, date, picks = 10) => ({
  Associate: name, "Pick Date": date, "Store #": "1458", "Picked As Req Qty": picks,
});

test("mergeWeekDoc keeps stored rows for dates the pull did not cover", () => {
  const existing = { rawData: [row("A", "9/12/26"), row("B", "9/13/26", 5)], store: "1458", weekStart: "2026-09-12" };
  const incoming = { rawData: [row("B", "9/13/26", 8), row("C", "9/14/26")], store: "1458", weekStart: "2026-09-12" };
  const merged = mergeWeekDoc(existing, incoming, { dates: ["2026-09-13", "2026-09-14"] });
  const by = (n) => merged.rawData.find((r) => r.Associate === n);
  assert.equal(merged.rawData.length, 3);
  assert.equal(by("A")["Pick Date"], "9/12/26", "untouched day survives");
  assert.equal(by("B")["Picked As Req Qty"], 8, "re-pulled day is replaced, not doubled");
  assert.ok(by("C"));
});

test("mergeWeekDoc drops stored rows for a re-pulled date that came back empty", () => {
  const existing = { rawData: [row("A", "9/12/26"), row("B", "9/13/26")] };
  const merged = mergeWeekDoc(existing, { rawData: [] }, { dates: ["2026-09-13"] });
  assert.deepEqual(merged.rawData.map((r) => r.Associate), ["A"]);
});

test("mergeWeekDoc forward-fills sparse Excel dates before filtering", () => {
  const existing = { rawData: [row("A", "9/12/26"), row("B", "", 5), row("C", "9/13/26")] };
  const merged = mergeWeekDoc(existing, { rawData: [] }, { dates: ["2026-09-13"] });
  assert.deepEqual(merged.rawData.map((r) => [r.Associate, r["Pick Date"]]),
                   [["A", "9/12/26"], ["B", "9/12/26"]]);
});

test("mergeWeekDoc never re-saves a placeholder name", () => {
  const existing = { rawData: [row("(unreadable)", "9/12/26"), row("A", "9/12/26")] };
  const merged = mergeWeekDoc(existing, { rawData: [] }, { dates: [] });
  assert.deepEqual(merged.rawData.map((r) => r.Associate), ["A"]);
});

test("mergeWeekDoc merges the Express map and keeps the stored file name", () => {
  const existing = {
    rawData: [row("A", "9/12/26")], fileName: "week.xlsx",
    express: { "2026-09-12": { orders: 1, units: 2 }, junk: { orders: 9 } },
  };
  const incoming = { rawData: [], fileName: null, express: { "2026-09-13": { orders: 3, units: 4 } } };
  const merged = mergeWeekDoc(existing, incoming, { dates: [] });
  assert.deepEqual(merged.express, {
    "2026-09-12": { orders: 1, units: 2 },
    "2026-09-13": { orders: 3, units: 4 },
  });
  assert.equal(merged.fileName, "week.xlsx");
  assert.equal(merged.rawData.length, 1);
});

test("mergeWeekDoc with nothing stored is the incoming document", () => {
  const incoming = { rawData: [row("A", "9/12/26")], store: "1458", weekStart: "2026-09-12" };
  const merged = mergeWeekDoc(null, incoming, { dates: ["2026-09-12"] });
  assert.equal(merged.rawData.length, 1);
  assert.equal(merged.express, null);
  assert.equal(merged.store, "1458");
});

// ── insights ─────────────────────────────────────────────────────────────

test("dailyPicks carries Express orders and picks per day, null when not pulled", () => {
  const express = { "2026-09-14": { orders: 33, units: 589 } };
  const days = dailyPicks([row("A", "9/13/26"), row("A", "9/14/26")], { A: "Digital" }, express);
  assert.equal(days[0].date, "9/14/26");
  assert.equal(days[0].expressOrders, 33);
  assert.equal(days[0].expressPicks, 589);
  assert.equal(days[1].expressOrders, null);
  assert.equal(days[1].expressPicks, null);

  const dist = distribution(days);
  assert.equal(dist.expressDays, 1);
  assert.equal(dist.expressOrders, 33);
  assert.equal(dist.expressPicks, 589);
});

test("distribution reports no Express totals when nothing was pulled", () => {
  const dist = distribution(dailyPicks([row("A", "9/13/26")], {}));
  assert.equal(dist.expressDays, 0);
  assert.equal(dist.expressOrders, null);
});

test("the Insights page shows Express columns, a dash for unpulled days, and totals", () => {
  const html = insightsPage.render({
    rawData: [row("A", "9/13/26"), row("A", "9/14/26")],
    associates: [], classifications: { A: "Digital" },
    express: { "2026-09-14": { orders: 33, units: 589 } },
  });
  assert.match(html, /Express Orders/);
  assert.match(html, /Express Picks/);
  assert.match(html, />33</);
  assert.match(html, />589</);
  assert.match(html, />—</);
  assert.match(html, /1 of 2 days/);
});

test("the Insights page renders without an Express map at all", () => {
  const html = insightsPage.render({ rawData: [row("A", "9/13/26")], associates: [], classifications: {} });
  assert.match(html, /Express Orders/);
  assert.doesNotMatch(html, /of 1 days/);
});
