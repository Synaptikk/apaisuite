// shared/tests/tabs.test.mjs
//
// Covers shared/tabs.js::findOrOpenTracked / closeIfOpened / withTempTab.
// Run with: node --test shared/tests/tabs.test.mjs
//
// The bug these guard against does not show up in a syntax check or in any
// test that asserts "the job got a tab": both the leak and the correct
// behaviour produce a usable tab. What separates them is whether the tab is
// still there afterwards, and — the half that is easy to over-correct —
// whether a tab the USER already had open survived. `removes` below counts
// closes so that closing someone else's tab fails the suite just as loudly as
// leaking our own.

import { test } from "node:test";
import assert from "node:assert/strict";

function installChromeStub(initial = []) {
  let nextId = 100;
  const tabs = new Map(initial.map((t) => [t.id, { active: false, ...t }]));
  const stats = { creates: 0, removes: 0, queries: 0, updates: 0 };
  globalThis.chrome = {
    tabs: {
      query: async ({ url }) => {
        stats.queries++;
        const re = new RegExp("^" + String(url).replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$");
        return [...tabs.values()].filter((t) => re.test(t.url));
      },
      create: async ({ url, active }) => {
        stats.creates++;
        const tab = { id: nextId++, url, active: !!active };
        tabs.set(tab.id, tab);
        return tab;
      },
      remove: async (id) => {
        stats.removes++;
        if (!tabs.has(id)) throw new Error("No tab with id: " + id);
        tabs.delete(id);
      },
      update: async (id, opts) => {
        stats.updates++;
        Object.assign(tabs.get(id), opts);
        return tabs.get(id);
      },
    },
  };
  return { tabs, stats };
}

const load = () => import(`../tabs.js?t=${process.hrtime.bigint()}`);

test("opened:true when no matching tab exists", async () => {
  const { stats } = installChromeStub();
  const { findOrOpenTracked } = await load();

  const state = await findOrOpenTracked("https://example.com/app");
  assert.equal(state.opened, true);
  assert.equal(stats.creates, 1);
  assert.equal(state.tab.url, "https://example.com/app");
});

test("opened:false when the user already has the site open", async () => {
  const { stats } = installChromeStub([{ id: 7, url: "https://example.com/somewhere-else" }]);
  const { findOrOpenTracked } = await load();

  const state = await findOrOpenTracked("https://example.com/app");
  assert.equal(state.opened, false);
  assert.equal(state.tab.id, 7);
  assert.equal(stats.creates, 0, "must adopt the existing tab, not open a second one");
});

test("closeIfOpened closes ours and spares theirs", async () => {
  const { tabs, stats } = installChromeStub([{ id: 7, url: "https://example.com/x" }]);
  const { findOrOpenTracked, closeIfOpened } = await load();

  const theirs = await findOrOpenTracked("https://example.com/app");
  assert.equal(await closeIfOpened(theirs), false);
  assert.equal(stats.removes, 0, "never close a tab the user already had");
  assert.ok(tabs.has(7));

  tabs.delete(7);
  const ours = await findOrOpenTracked("https://example.com/app");
  assert.equal(await closeIfOpened(ours), true);
  assert.equal(stats.removes, 1);
  assert.equal(tabs.size, 0);
});

test("closeIfOpened swallows an already-gone tab", async () => {
  const { tabs } = installChromeStub();
  const { findOrOpenTracked, closeIfOpened } = await load();

  const ours = await findOrOpenTracked("https://example.com/app");
  tabs.clear(); // user closed it mid-job
  assert.equal(await closeIfOpened(ours), false, "must not throw — the tab being gone IS the goal");
});

test("withTempTab closes on the throw path", async () => {
  const { tabs, stats } = installChromeStub();
  const { withTempTab } = await load();

  await assert.rejects(
    withTempTab("https://example.com/app", async () => { throw new Error("job blew up"); }),
    /job blew up/
  );
  assert.equal(stats.removes, 1, "the failure path is the one that actually leaked in practice");
  assert.equal(tabs.size, 0);
});

test("withTempTab leaves the user's tab alone even when the job throws", async () => {
  const { tabs, stats } = installChromeStub([{ id: 7, url: "https://example.com/x" }]);
  const { withTempTab } = await load();

  await assert.rejects(
    withTempTab("https://example.com/app", async () => { throw new Error("nope"); }),
    /nope/
  );
  assert.equal(stats.removes, 0);
  assert.ok(tabs.has(7));
});

test("accept filters out a tab that matches the host but not the view", async () => {
  // Tableau's view lives in the URL fragment, which match patterns cannot see.
  // Adopting the wrong view captures the wrong data and looks entirely healthy.
  const { stats } = installChromeStub([
    { id: 7, url: "https://tableau.example.com/#/site/S/views/Other/Other" },
  ]);
  const { findOrOpenTracked } = await load();

  const state = await findOrOpenTracked("https://tableau.example.com/#/site/S/views/Want/Want", {
    accept: (t) => t.url.includes("/views/Want/"),
  });
  assert.equal(state.opened, true, "host matched but the view did not — must open our own");
  assert.equal(stats.creates, 1);
});

test("legacy findOrOpen still returns a bare tab", async () => {
  installChromeStub();
  const { createTabs } = await load();

  const tab = await createTabs().findOrOpen("https://example.com/app");
  assert.equal(tab.url, "https://example.com/app");
  assert.equal(tab.opened, undefined);
});
