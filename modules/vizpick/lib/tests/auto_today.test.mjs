// modules/vizpick/lib/tests/auto_today.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/auto_today.test.mjs
//
// resolveAutoTodayMarket decides whether the background Today refresh does
// anything at all. Its first version gated on the home market alone and
// returned silently when unset — so on a profile with no home market the whole
// feature was a no-op that said nothing, and was reported as "still manual
// only". These pin both the fallback and the reason strings, because the
// reasons are what the UI shows and a silent null is the failure mode.

import { test } from "node:test";
import assert from "node:assert/strict";

// service.js reaches for chrome at import time (storage/alarms). Stub enough
// for the module to load; only the pure resolver is exercised here.
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} },
             sync:  { get: async () => ({}) },
             session: { get: async () => ({}) } },
  alarms:  { get: async () => null, create: async () => {}, onAlarm: { addListener() {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener() {} } },
  tabs:    { query: async () => [] },
};

const { resolveAutoTodayMarket } = await import("../../service.js");

const store = (opts = {}) => ({
  days: [{ rows: [
    { store: "1458", market: "120" },
    { store: "3660", market: "120" },
    { store: "999",  market: "323" },
  ] }],
  today: opts.todayMarket ? { market: opts.todayMarket, rows: [] } : null,
});

test("home market wins and yields only that market's stores", () => {
  const r = resolveAutoTodayMarket(store(), "120");
  assert.equal(r.market, "120");
  assert.equal(r.source, "home-market");
  assert.deepEqual(r.stores, ["1458", "3660"]);
  assert.equal(r.reason, null);
});

test("with no home market it follows the market already loaded by hand", () => {
  // The original bug: this returned nothing, so auto-refresh never ran for
  // anyone who had not set a home market. Following a hand-loaded market is
  // not "a market nobody asked for" — the user loaded it themselves.
  const r = resolveAutoTodayMarket(store({ todayMarket: "323" }), null);
  assert.equal(r.market, "323");
  assert.equal(r.source, "last-loaded");
  assert.deepEqual(r.stores, ["999"]);
});

test("home market takes precedence over a hand-loaded peer market", () => {
  const r = resolveAutoTodayMarket(store({ todayMarket: "323" }), "120");
  assert.equal(r.market, "120");
  assert.equal(r.source, "home-market");
});

test("nothing to follow gives an ACTIONABLE reason, not a bare null", () => {
  const r = resolveAutoTodayMarket(store(), null);
  assert.equal(r.market, null);
  assert.match(r.reason, /Settings > Defaults/);
  assert.match(r.reason, /load Today for a market once/);
});

test("a market absent from the roster says so rather than failing silently", () => {
  const r = resolveAutoTodayMarket(store(), "999999");
  assert.equal(r.market, null);
  assert.match(r.reason, /999999/);
  assert.match(r.reason, /Yesterday/);
});

test("no Yesterday capture yet is reported, not treated as 'no market'", () => {
  const r = resolveAutoTodayMarket({ days: [], today: null }, "120");
  assert.equal(r.market, null);
  assert.match(r.reason, /roster/);
});

test("market matching is by string, so a padded market still matches itself", () => {
  const padded = { days: [{ rows: [{ store: "1", market: "0120" }] }], today: null };
  assert.deepEqual(resolveAutoTodayMarket(padded, "0120").stores, ["1"]);
  // And does NOT match the unpadded form — the value is stored as typed, so a
  // mismatch here is a real config error the reason string should surface.
  assert.equal(resolveAutoTodayMarket(padded, "120").market, null);
});

test("tolerates a missing or malformed store", () => {
  for (const bad of [undefined, null, {}, { days: null }]) {
    const r = resolveAutoTodayMarket(bad, "120");
    assert.equal(r.market, null);
    assert.ok(r.reason);
  }
});

test("the suite_opened handler exists — the shell dispatch is conditional", async () => {
  // app.js only messages modules that HAVE this handler, so dropping it in a
  // refactor would silently disable the on-open refresh with no error anywhere.
  const mod = await import("../../module.js");
  const handlers = mod.default?.manifest?.service?.handlers;
  assert.equal(typeof handlers?.suite_opened, "function",
    "vizpick opts into the shell's on-open check by exposing this handler");
});

test("openCheck is exported for the handler to call", async () => {
  const svc = await import("../../service.js");
  assert.equal(typeof svc.openCheck, "function");
});
