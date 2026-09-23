// shared/tests/digitalrollup_pick_history.test.mjs
//
// Covers modules/digitalrollup/lib/pick_history.js — the rolling "items
// picked in the last hour" derived from the board's running day total.
// Run with: node --test shared/tests/digitalrollup_pick_history.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { recordSnapshot, rollingWindow, parseCount, hourlyBars, dayStartFrom, HOUR_MS } from "../../modules/digitalrollup/lib/pick_history.js";

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

test("hourly bars: 'before' block up to the first full hour, measured hours, a partial now", () => {
  const H = 60 * MIN;
  const start = T0;                       // day starts at T0 (think 5 AM)
  let h = null;
  // First reading at +2h30 with 3,000 picked; then 1,200/hr, read every 10 min.
  for (let m = 150; m <= 285; m += 5) h = recordSnapshot(h, snap(m, { 1458: 3000 + (m - 150) * 20 }));
  const r = hourlyBars(h.series["1458"], start);
  // Nothing is known hour by hour before the first reading: one block to +3h.
  assert.equal(r.before.start, start);
  assert.equal(r.before.end, start + 3 * H);
  assert.equal(r.before.picked, 3600);             // 3,000 + 30 min at 1,200/hr
  assert.equal(r.before.perHour, 1200);
  assert.deepEqual(r.hours.map((x) => [x.kind, x.picked]), [["hour", 1200], ["now", 900]]);
  assert.equal(r.hours[1].end, start + 285 * MIN);
  assert.equal(r.total, 5700);
  assert.equal(r.dayAvgPerHour, Math.round(5700 / 4.75));
});

test("hourly bars: readings from before the day start leave no 'before' block", () => {
  let h = null;
  for (let m = 0; m <= 120; m += 10) h = recordSnapshot(h, snap(m, { 1458: m * 10 }));
  const r = hourlyBars(h.series["1458"], T0);
  assert.equal(r.before, null);
  assert.deepEqual(r.hours.map((x) => x.picked), [600, 600]);
  assert.equal(hourlyBars([], T0), null);
});

test("day start is read from the board's window label, else 5 AM local", () => {
  const got = dayStartFrom({ dataAge: { tooltip: "Real-time from GRT (2026-09-23 05:00:00 to 2026-09-24 04:59:59)" } });
  assert.equal(got, new Date(2026, 8, 23, 5, 0).getTime());
  const fallback = dayStartFrom({}, new Date(2026, 8, 23, 14, 7).getTime());
  assert.equal(fallback, new Date(2026, 8, 23, 5, 0).getTime());
});

test("HOUR_MS is an hour", () => assert.equal(HOUR_MS, 60 * MIN));

// ── pick_chart.js ─────────────────────────────────────────────────────────
import { barChartSvg, niceStep, EXPORT_PALETTE } from "../../modules/digitalrollup/lib/pick_chart.js";

test("bar chart: before block, one bar per hour, hour labels, avg line", () => {
  let h = null;
  for (let m = 150; m <= 285; m += 5) h = recordSnapshot(h, snap(m, { 1458: 3000 + (m - 150) * 20 }));
  const day = hourlyBars(h.series["1458"], T0);
  assert.equal(barChartSvg(null), "");
  const svg = barChartSvg(day);
  assert.equal((svg.match(/<path /g) || []).length, 3);          // before + 2 hours
  assert.equal((svg.match(/data-tip=/g) || []).length, 3);
  assert.match(svg, /fill-opacity:0.4/);                          // the "so far" bar
  assert.match(svg, /avg 1,200/);
  const png = barChartSvg(day, { width: 800, height: 420, palette: EXPORT_PALETTE, title: "t", subtitle: "s" });
  assert.match(png, /fill:#FFFFFF/);
  assert.match(png, /900 so far/);
  assert.doesNotMatch(png, /var\(|data-tip/);
});

test("niceStep picks 1/2/2.5/5 × 10^n", () => {
  assert.equal(niceStep(2000), 1000);
  assert.equal(niceStep(1800), 1000);
  assert.equal(niceStep(600), 200);
  assert.equal(niceStep(7), 2.5);
});
