// shared/tests/digitalrollup_pick_history.test.mjs
//
// Covers modules/digitalrollup/lib/pick_history.js — the rolling "items
// picked in the last hour" derived from the board's running day total.
// Run with: node --test shared/tests/digitalrollup_pick_history.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { recordSnapshot, rollingWindow, parseCount, dayAverage, rateSeries, HOUR_MS } from "../../modules/digitalrollup/lib/pick_history.js";

const MIN = 60_000;
const T0 = Date.parse("2026-09-23T12:00:00Z");
const snap = (minute, picks, extra = {}) => ({
  market: "29",
  reportDate: "2026-09-23",
  refreshedAtIso: new Date(T0 + minute * MIN).toISOString(),
  capturedAt: T0 + minute * MIN + 5_000,
  cards: Object.entries(picks).map(([store, total]) => ({ store_nbr: Number(store), picking: { total_picks: total } })),
  ...extra,
});

test("a steady 10 items/min reads as 600 in the last hour", () => {
  let h = null;
  for (let m = 0; m <= 90; m += 10) h = recordSnapshot(h, snap(m, { 1458: 1000 + m * 10 }));
  const r = rollingWindow(h.series["1458"]);
  assert.equal(r.full, true);
  assert.equal(r.picked, 600);
  assert.equal(r.perHour, 600);
});

test("the hour boundary is interpolated between straddling samples", () => {
  let h = null;
  // Samples at 0, 25, 70 minutes: the window starts at minute 10.
  h = recordSnapshot(h, snap(0, { 1458: 0 }));
  h = recordSnapshot(h, snap(25, { 1458: 250 }));
  h = recordSnapshot(h, snap(70, { 1458: 700 }));
  // Total at minute 10 ≈ 100, so 700 − 100.
  assert.equal(rollingWindow(h.series["1458"]).picked, 600);
});

test("under an hour of history is reported as partial with a scaled pace", () => {
  let h = null;
  h = recordSnapshot(h, snap(0, { 1458: 500 }));
  h = recordSnapshot(h, snap(20, { 1458: 700 }));
  const r = rollingWindow(h.series["1458"]);
  assert.equal(r.full, false);
  assert.equal(r.picked, 200);
  assert.equal(r.spanMs, 20 * MIN);
  assert.equal(r.perHour, 600);
});

test("a repeat fetch of an unchanged board is not a second sample", () => {
  let h = recordSnapshot(null, snap(0, { 1458: 500 }));
  h = recordSnapshot(h, { ...snap(0, { 1458: 500 }), capturedAt: T0 + 9 * MIN });
  assert.equal(h.series["1458"].length, 1);
  assert.equal(rollingWindow(h.series["1458"]), null);
});

test("a new report day or market restarts the series", () => {
  let h = recordSnapshot(null, snap(0, { 1458: 9000 }));
  h = recordSnapshot(h, snap(10, { 1458: 20 }, { reportDate: "2026-09-24" }));
  assert.deepEqual(h.series["1458"].map((s) => s[1]), [20]);
  h = recordSnapshot(h, snap(20, { 1458: 30 }, { market: "120", reportDate: "2026-09-24" }));
  assert.equal(h.market, "120");
  assert.deepEqual(h.series["1458"].map((s) => s[1]), [30]);
});

test("a drop in the running total resets that store only", () => {
  let h = recordSnapshot(null, snap(0, { 1458: 900, 100: 50 }));
  h = recordSnapshot(h, snap(10, { 1458: 10, 100: 80 }));
  assert.deepEqual(h.series["1458"].map((s) => s[1]), [10]);
  assert.equal(h.series["100"].length, 2);
});

test("stores missing a total are skipped, not zeroed", () => {
  const h = recordSnapshot(null, { ...snap(0, {}), cards: [{ store_nbr: 1458, picking: { total_picks: null } }] });
  assert.equal(h.series["1458"], undefined);
});

test("the API's comma-formatted string totals are parsed", () => {
  let h = recordSnapshot(null, snap(0, { 1458: "9,630" }));
  h = recordSnapshot(h, snap(60, { 1458: "10,230" }));
  assert.equal(rollingWindow(h.series["1458"]).picked, 600);
  assert.ok(Number.isNaN(parseCount("—")));
});

test("tracking can be limited to the home store, matched numerically", () => {
  const h = recordSnapshot(null, snap(0, { 1458: 10, 100: 20 }), { stores: ["01458"] });
  assert.deepEqual(Object.keys(h.series), ["1458"]);
  const none = recordSnapshot(null, snap(0, { 1458: 10 }), { stores: [null] });
  assert.deepEqual(none.series, {});
});

test("the day average spans first to latest reading", () => {
  let h = null;
  // 300/hr for two hours, then 900/hr for one: 1500 over 3h = 500/hr.
  h = recordSnapshot(h, snap(0, { 1458: 0 }));
  h = recordSnapshot(h, snap(120, { 1458: 600 }));
  h = recordSnapshot(h, snap(180, { 1458: 1500 }));
  const d = dayAverage(h.series["1458"]);
  assert.equal(d.perHour, 500);
  assert.equal(d.since, T0);
  assert.equal(rollingWindow(h.series["1458"]).perHour, 900);
  assert.equal(dayAverage(h.series["1458"].slice(0, 1)), null);
});

test("15-second polls keep minute-spaced history with a current tail", () => {
  let h = null;
  const SEC = 1000;
  for (let s = 0; s <= 180; s += 15) {
    h = recordSnapshot(h, { ...snap(0, { 1458: 1000 + s }), refreshedAtIso: new Date(T0 + s * SEC).toISOString() });
  }
  const series = h.series["1458"];
  // Latest total is always the newest reading.
  assert.deepEqual(series.at(-1), [T0 + 180 * SEC, 1180]);
  // Everything before the tail is at least a minute apart.
  for (let i = 1; i < series.length - 1; i++) assert.ok(series[i][0] - series[i - 1][0] >= 60 * SEC);
  assert.ok(series.length <= 5, `got ${series.length}`);
  assert.equal(rollingWindow(series).perHour, 3600);
});

test("rate series: trailing-window rate on wall-clock steps, ending at the latest reading", () => {
  let h = null;
  // 600/hr for 30 min, then 1200/hr for 30 min, read every 5 min.
  for (let m = 0; m <= 60; m += 5) h = recordSnapshot(h, snap(m, { 1458: m <= 30 ? m * 10 : 300 + (m - 30) * 20 }));
  const pts = rateSeries(h.series["1458"]);
  assert.equal(pts[0][0], T0 + 15 * MIN);
  assert.equal(pts[0][1], 600);
  assert.deepEqual(pts.at(-1), [T0 + 60 * MIN, 1200]);
  assert.ok(pts.every(([t], i) => i === 0 || t > pts[i - 1][0]));
  assert.deepEqual(rateSeries(h.series["1458"].slice(0, 2)), []);
});

test("HOUR_MS is an hour", () => assert.equal(HOUR_MS, 60 * MIN));

// ── pick_chart.js ─────────────────────────────────────────────────────────
import { chartSvg, niceStep, EXPORT_PALETTE } from "../../modules/digitalrollup/lib/pick_chart.js";

test("chart: empty under two points, one path, end label, avg line", () => {
  assert.equal(chartSvg([[T0, 100]]), "");
  const pts = [[T0, 1200], [T0 + 30 * MIN, 1500], [T0 + 60 * MIN, 1780]];
  const svg = chartSvg(pts, { avg: 1650 });
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.match(svg, />1,780\/hr</);
  assert.match(svg, /avg 1,650/);
  assert.match(svg, /data-t0=/);
  const png = chartSvg(pts, { avg: 1650, width: 800, height: 420, palette: EXPORT_PALETTE, title: "Store 1458", subtitle: "x" });
  assert.match(png, /fill:#FFFFFF/);
  assert.doesNotMatch(png, /var\(|data-t0/);
});

test("niceStep picks 1/2/2.5/5 × 10^n", () => {
  assert.equal(niceStep(2000), 1000);
  assert.equal(niceStep(1800), 1000);
  assert.equal(niceStep(600), 200);
  assert.equal(niceStep(7), 2.5);
});
