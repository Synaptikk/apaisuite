// shared/tests/tabSessions.test.mjs
//
// Covers shared/tabSessions.js — the idle reaper for background tabs that a
// module must keep alive between calls.
// Run with: node --test shared/tests/tabSessions.test.mjs
//
// The two failure modes this guards are opposite and equally bad: reaping a
// tab that is still being used (which re-pays a 30s Looker/SAML reauth and
// looks like a random hang), and never reaping at all (the original bug). So
// every test here asserts on WHICH tabs survived, not just that the sweep ran.

import { test } from "node:test";
import assert from "node:assert/strict";

function installChromeStub(openTabIds = []) {
  const store = {};
  const tabs = new Set(openTabIds);
  const stats = { removes: 0 };
  globalThis.chrome = {
    storage: {
      session: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (obj) => Object.assign(store, obj),
      },
    },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("No tab with id: " + id);
        return { id };
      },
      remove: async (id) => {
        stats.removes++;
        if (!tabs.has(id)) throw new Error("No tab with id: " + id);
        tabs.delete(id);
      },
    },
  };
  return { tabs, stats, store };
}

const load = () => import(`../tabSessions.js?t=${process.hrtime.bigint()}`);

const MIN = 60 * 1000;

test("reaps a tab that has gone quiet past its idle window", async () => {
  const { tabs } = installChromeStub([1]);
  const { registerSessionTab, reapIdleTabs, DEFAULT_IDLE_MS } = await load();

  await registerSessionTab("claimsdisposition", 1);
  const res = await reapIdleTabs(Date.now() + DEFAULT_IDLE_MS + MIN);

  assert.equal(res.closed.length, 1);
  assert.equal(res.closed[0].moduleId, "claimsdisposition");
  assert.equal(tabs.has(1), false);
});

test("spares a tab still inside its idle window", async () => {
  const { tabs, stats } = installChromeStub([1]);
  const { registerSessionTab, reapIdleTabs } = await load();

  await registerSessionTab("livedashboard", 1);
  const res = await reapIdleTabs(Date.now() + MIN);

  assert.equal(res.kept, 1);
  assert.equal(stats.removes, 0);
  assert.ok(tabs.has(1));
});

test("touch resets the clock — an in-use tab is never reaped", async () => {
  // The regression this pins: a 500-name lookup pass runs for many minutes
  // against ONE tab. Reaping mid-pass would kill the pass.
  const { tabs, stats } = installChromeStub([1]);
  const { registerSessionTab, touchSessionTab, reapIdleTabs, DEFAULT_IDLE_MS } = await load();

  await registerSessionTab("associateLookup", 1);
  // Simulate the pass running long: the registration is old, but the tab was
  // used moments ago. Only the LAST use may decide.
  await touchSessionTab(1);

  const res = await reapIdleTabs(Date.now() + DEFAULT_IDLE_MS / 2);
  assert.equal(res.kept, 1);
  assert.equal(stats.removes, 0);
  assert.ok(tabs.has(1));
});

test("per-tab idleMs is honoured over the default", async () => {
  const { tabs } = installChromeStub([1, 2]);
  const { registerSessionTab, reapIdleTabs } = await load();

  await registerSessionTab("fast", 1, { idleMs: 1 * MIN });
  await registerSessionTab("slow", 2, { idleMs: 60 * MIN });
  const res = await reapIdleTabs(Date.now() + 5 * MIN);

  assert.deepEqual(res.closed.map((c) => c.tabId), [1]);
  assert.equal(res.kept, 1);
  assert.equal(tabs.has(2), true);
});

test("a tab the user already closed is dropped, not reported as reaped", async () => {
  const { stats } = installChromeStub([]); // registered id is not open
  const { registerSessionTab, reapIdleTabs, listSessionTabs } = await load();

  await registerSessionTab("workvivo", 99);
  const res = await reapIdleTabs(Date.now());

  assert.equal(res.closed.length, 0, "we did not close it — it was already gone");
  assert.equal(res.dropped.length, 1);
  assert.equal(stats.removes, 0);
  assert.deepEqual(await listSessionTabs(), [], "registration must not linger");
});

test("forgetSessionTab releases a tab without closing it", async () => {
  const { tabs, stats } = installChromeStub([1]);
  const { registerSessionTab, forgetSessionTab, reapIdleTabs, DEFAULT_IDLE_MS } = await load();

  await registerSessionTab("sparkfraud", 1);
  await forgetSessionTab(1);
  const res = await reapIdleTabs(Date.now() + DEFAULT_IDLE_MS + MIN);

  assert.equal(res.closed.length, 0);
  assert.equal(stats.removes, 0);
  assert.ok(tabs.has(1), "forget means 'stop tracking', never 'close'");
});

test("touching an unregistered tab is a no-op, not a throw", async () => {
  installChromeStub([5]);
  const { touchSessionTab, listSessionTabs } = await load();

  await touchSessionTab(5); // adopted tab — callers don't know it isn't ours
  assert.deepEqual(await listSessionTabs(), []);
});

test("survives a corrupt / absent registry", async () => {
  const { store } = installChromeStub([]);
  const { reapIdleTabs } = await load();

  store["_suite_tabSessions"] = "not an object";
  const res = await reapIdleTabs(Date.now());
  assert.deepEqual(res, { closed: [], kept: 0, dropped: [] });
});
