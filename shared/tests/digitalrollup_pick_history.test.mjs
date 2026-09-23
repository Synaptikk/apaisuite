// shared/tests/digitalrollup_pick_history.test.mjs
//
// Covers modules/digitalrollup/lib/pick_history.js — the rolling "items
// picked in the last hour" derived from the board's running day total.
// Run with: node --test shared/tests/digitalrollup_pick_history.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { recordSnapshot, rollingWindow, parseCount, HOUR_MS } from "../../modules/digitalrollup/lib/pick_history.js";

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

test("HOUR_MS is an hour", () => assert.equal(HOUR_MS, 60 * MIN));
