// modules/digitalrollup/lib/tests/normalize.test.mjs
//
// Run with: node --test modules/digitalrollup/lib/tests/normalize.test.mjs
//
// The fixture below is a real /api/dashboard?market=120 card and summary,
// trimmed to one store, captured live on 2026-08-22. Keep it real: the point
// of these tests is to catch the GIF app changing shape under us, and a
// hand-written fixture would only ever agree with our assumptions.
//
// This is the same failure mode that hid the VizPick column rename for two
// days (CURRENT_TASKS.md §8) — a required field disappears, the parse guard
// rejects every row, and the stored snapshot keeps rendering as though
// nothing happened.

import test from "node:test";
import assert from "node:assert/strict";
import { flattenKeys, normalizeDashboard, REQUIRED_CARD_PATHS } from "../normalize.js";

const CARD = {
  store_nbr: 658,
  store_name: "Store 658",
  report_date: "2026-08-22",
  report_date_fmt: "Sat, Aug 22, 2026",
  wm_week: null,
  picking: {
    status: "green", status_label: "On track",
    on_time_pct: 100, on_time_fmt: "100.0%",
    pick_rate: 92.51, pick_rate_fmt: "92.5", pick_rate_status: "yellow",
    total_picks: "6,405", total_picks_raw: 6405,
    remaining: "—", orders_raw: 5,
    is_overdue: false, overdue_minutes: 0, is_at_risk: false, at_risk_minutes: 0,
  },
  staging: {
    totes_to_stage: 51, totes_to_stage_fmt: "51", totes_to_stage_status: "yellow",
    scan_stage_pct: null, scan_stage_fmt: "—", scan_stage_status: "gray",
    scan_total_totes: 0, scan_staged_totes: 0,
  },
  dispense: {
    status: "yellow", status_label: "Watch",
    in_queue: 5, in_queue_fmt: "5", high_wait: 0, high_wait_fmt: "0",
    exceptions: 1, exceptions_fmt: "1", early_removals: 1, early_removals_fmt: "1",
    wait_time: 6.02, wait_time_fmt: "6.0 min", wait_time_status: "red",
  },
  quality: {
    pre_sub_pct: 97.28, pre_sub_fmt: "97.3%", pre_sub_status: "green",
    post_sub_pct: 99.04, post_sub_fmt: "99.0%", post_sub_status: "green",
    ftp_pct: null, ftp_fmt: "—", ftp_status: "gray",
    nil_pick_pct: null, nil_pick_fmt: "—", nil_status: "gray",
  },
  live_meta: { ring: "r2", has_data: true },
};

const SUMMARY = {
  total_orders: "48",
  avg_on_time_pick: "99.8%", avg_on_time_pick_status: "green",
  avg_scan_stage: "—", avg_scan_stage_status: "gray",
  avg_pre_sub: "96.8%", avg_pre_sub_status: "green",
  avg_post_sub: "99.0%", avg_post_sub_status: "green",
  avg_pick_rate: "93.2", avg_pick_rate_status: "yellow",
  avg_wait_time: "4.7 min", avg_wait_status: "green",
  total_items_picked: "62,450",
  avg_ftp: "—", avg_ftp_status: "gray",
  avg_nil_pick: "—", avg_nil_status: "gray",
};

const PAYLOAD = {
  market_nbr: 120,
  report_date: "2026-08-22",
  report_date_fmt: "Sat, Aug 22, 2026",
  data_granularity: "Real-Time",
  data_age: { text: "Live", status: "fresh", tooltip: "Real-time from GRT" },
  refreshed_at: "11:32 AM CT",
  refreshed_at_full: "Sat, Aug 22, 2026 at 11:32:04 AM CT",
  refreshed_at_iso: "2026-08-22T11:32:04.089216-05:00",
  store_count: 1,
  cards: [CARD],
  summary: SUMMARY,
};

test("a live payload normalises and keeps its cards verbatim", () => {
  const { ok, missing, snapshot } = normalizeDashboard(PAYLOAD, { market: "120" });
  assert.equal(ok, true);
  assert.deepEqual(missing, []);
  assert.equal(snapshot.market, "120");
  assert.equal(snapshot.storeCount, 1);
  assert.equal(snapshot.refreshedAt, "11:32 AM CT");
  // Verbatim is the contract — the view reads card.picking.on_time_fmt
  // straight off the API. A renaming layer here could only ever disagree
  // with the source.
  assert.deepEqual(snapshot.cards[0], CARD);
});

test("a missing required field fails the parse and names what went", () => {
  const broken = structuredClone(PAYLOAD);
  delete broken.cards[0].picking.on_time_fmt;
  const { ok, missing, snapshot } = normalizeDashboard(broken, { market: "120" });
  assert.equal(ok, false);
  assert.equal(snapshot, null);
  assert.ok(missing.includes("cards[].picking.on_time_fmt"));
});

test("a null value is data, not a missing field", () => {
  // ftp_pct is null for every store in market 120 today and scan_stage_pct is
  // null wherever scan-to-stage is not in use. Those render as an em-dash;
  // they must not fail the guard, or the board would never load at all.
  const { ok } = normalizeDashboard(PAYLOAD, { market: "120" });
  assert.equal(ok, true);
  assert.equal(PAYLOAD.cards[0].quality.ftp_pct, null);
  assert.ok(!REQUIRED_CARD_PATHS.includes("quality.ftp_pct"));
});

test("an empty cards[] is a failure, not an empty market", () => {
  // A market with no stores is not a thing. An empty array means the pull
  // succeeded against the wrong market or the app returned a shell — either
  // way, storing it would replace a good snapshot with nothing.
  const { ok, missing } = normalizeDashboard({ ...PAYLOAD, cards: [] }, { market: "120" });
  assert.equal(ok, false);
  assert.ok(missing.includes("cards[]"));
});

test("flattenKeys walks one level and sorts, for the schema watcher", () => {
  const keys = flattenKeys(CARD);
  assert.ok(keys.includes("picking.on_time_fmt"));
  assert.ok(keys.includes("live_meta.has_data"));
  assert.ok(keys.includes("store_nbr"));
  // wm_week is null — a null leaf is still a key that exists, and its
  // disappearance is exactly what the watcher is for.
  assert.ok(keys.includes("wm_week"));
  assert.deepEqual(keys, [...keys].sort());
});

test("the *_status vocabulary survives normalisation", () => {
  // This module deliberately computes no bands of its own; it paints what the
  // API decided. If these ever stop arriving, every figure silently renders
  // neutral and a red store looks fine.
  const { snapshot } = normalizeDashboard(PAYLOAD, { market: "120" });
  const c = snapshot.cards[0];
  assert.equal(c.dispense.wait_time_status, "red");
  assert.equal(c.picking.pick_rate_status, "yellow");
  assert.equal(c.quality.pre_sub_status, "green");
  assert.equal(c.staging.scan_stage_status, "gray");
});
