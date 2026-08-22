// shared/tests/alarms.test.mjs
//
// Covers shared/alarms.js::ensureAlarm.
// Run with: node --test shared/tests/alarms.test.mjs
//
// The bug this guards against is invisible to a syntax check and to any test
// that only asserts "an alarm exists afterwards": chrome.alarms.create()
// CANCELS a same-named alarm and reschedules it, restarting the period. Five
// modules called create() unconditionally from a code path that ran on every
// shell page load, so their alarms never fired. The `creates` counter below is
// the whole point — it asserts we did not touch an alarm that was already
// correct, not merely that one is present.

import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal chrome.alarms double. `creates` counts writes so a needless
// re-create is a test failure, not an invisible regression.
function installChromeStub() {
  const alarms = new Map();
  const stats = { creates: 0, gets: 0 };
  globalThis.chrome = {
    alarms: {
      get: async (name) => { stats.gets++; return alarms.get(name); },
      create: async (name, info) => {
        stats.creates++;
        alarms.set(name, { name, ...info });
      },
    },
  };
  return { alarms, stats };
}

const load = () => import(`../alarms.js?t=${process.hrtime.bigint()}`);

test("creates the alarm when none exists", async () => {
  const { alarms, stats } = installChromeStub();
  const { ensureAlarm } = await load();

  const res = await ensureAlarm("a", { periodInMinutes: 30, delayInMinutes: 1 });
  assert.equal(res.created, true);
  assert.equal(stats.creates, 1);
  assert.deepEqual(alarms.get("a"), { name: "a", delayInMinutes: 1, periodInMinutes: 30 });
});

test("does NOT re-create an alarm that already has the right period", async () => {
  const { stats } = installChromeStub();
  const { ensureAlarm } = await load();

  await ensureAlarm("a", { periodInMinutes: 30 });
  assert.equal(stats.creates, 1);

  // This is the regression. Calling again — as every shell page load did —
  // must leave the pending alarm's countdown alone.
  for (let i = 0; i < 5; i++) {
    const res = await ensureAlarm("a", { periodInMinutes: 30 });
    assert.equal(res.created, false);
  }
  assert.equal(stats.creates, 1, "an existing correct alarm must never be re-created");
});

test("re-creates when the period constant changed", async () => {
  const { alarms, stats } = installChromeStub();
  const { ensureAlarm } = await load();

  await ensureAlarm("a", { periodInMinutes: 30 });
  const res = await ensureAlarm("a", { periodInMinutes: 60 });

  assert.equal(res.created, true);
  assert.match(res.reason, /30 -> 60/);
  assert.equal(stats.creates, 2);
  assert.equal(alarms.get("a").periodInMinutes, 60);
});

test("first fire defaults to one full period when no delay is given", async () => {
  const { alarms } = installChromeStub();
  const { ensureAlarm } = await load();

  // Matches Chrome's own behaviour for an omitted delayInMinutes, so callers
  // that never set one keep the schedule they had before this helper existed.
  await ensureAlarm("a", { periodInMinutes: 15 });
  assert.equal(alarms.get("a").delayInMinutes, 15);
});

test("a get() failure falls through to create rather than reporting success", async () => {
  installChromeStub();
  const { ensureAlarm } = await load();
  chrome.alarms.get = async () => { throw new Error("no permission"); };

  // Swallowing the error into "already scheduled" would leave the extension
  // with no alarm at all and no complaint.
  const res = await ensureAlarm("a", { periodInMinutes: 5 });
  assert.equal(res.created, true);
});

test("rejects a missing name or a non-positive period", async () => {
  installChromeStub();
  const { ensureAlarm } = await load();

  await assert.rejects(() => ensureAlarm("", { periodInMinutes: 5 }), /name is required/);
  await assert.rejects(() => ensureAlarm("a", { periodInMinutes: 0 }), /must be > 0/);
  await assert.rejects(() => ensureAlarm("a"), /must be > 0/);
});

test("IS_SERVICE_WORKER is false under a DOM-ish global, true without one", async () => {
  installChromeStub();

  globalThis.window = {};
  const asPage = await load();
  assert.equal(asPage.IS_SERVICE_WORKER, false);

  delete globalThis.window;
  const asWorker = await load();
  assert.equal(asWorker.IS_SERVICE_WORKER, true);
});
