import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureTab } from "../background_tab.js";
import * as snapshots from "../snapshots.js";

test("background capture selects an explicit normal window and handles none", async () => {
  let created;
  const session = {};
  globalThis.chrome = { windows: { getAll: async () => [{ id: 7 }] },
    tabs: { create: async (opts) => { created = opts; return { id: 1 }; } },
    storage: { session: {
      get: async () => structuredClone(session),
      set: async (obj) => Object.assign(session, structuredClone(obj)),
    } } };
  await createCaptureTab("https://example.com");
  assert.equal(created.windowId, 7);
  assert.equal(created.active, false);
  chrome.windows.getAll = async () => [];
  await assert.rejects(createCaptureTab("https://example.com"), /No browser window/);
});

test("capture tabs are registered with the tab reaper, above the keep-alive window", async () => {
  // The regression: a worker killed mid-crawl never reached its `finally`, so
  // nothing closed its lanes. The reaper registry is what outlives the worker.
  const session = {};
  globalThis.chrome = { windows: { getAll: async () => [{ id: 7, focused: true }] },
    tabs: { create: async () => ({ id: 42 }) },
    storage: { session: {
      get: async () => structuredClone(session),
      set: async (obj) => Object.assign(session, structuredClone(obj)),
    } } };
  const { CAPTURE_TAB_IDLE_MS } = await import("../background_tab.js");
  const { listSessionTabs } = await import("../../../../shared/tabSessions.js");
  await createCaptureTab("https://example.com");
  const entry = (await listSessionTabs()).find((e) => Number(e.tabId) === 42);
  assert.equal(entry?.moduleId, "vizpick");
  assert.ok(CAPTURE_TAB_IDLE_MS > 35 * 60_000, "must outlast sw_keepalive's 35 min hold");
});

test("partial same-stamp refresh preserves coverage; parallel lanes retain rows", async () => {
  const db = {};
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(db),
    set: async (obj) => Object.assign(db, structuredClone(obj)),
  } } };
  const base = { sourceUpdate: { raw: "stamp" }, market: "120", capturedAt: "2026-09-09T19:00:00Z" };
  await snapshots.recordToday({ ...base, rows: [{ store: "1", hasHealth: true }, { store: "2" }], partial: false });
  await snapshots.recordToday({ ...base, rows: [{ store: "1" }], partial: true });
  await Promise.all([3, 4].map((id) => snapshots.mergeToday({ ...base, rows: [{ store: String(id) }], partial: true })));
  let saved = (await snapshots.read()).today;
  assert.equal(saved.rows.length, 4);
  assert.equal(saved.partial, false);
  assert.equal(saved.rows.find((r) => r.store === "1").hasHealth, true, "failed same-source retry cannot erase healthy data");
  await snapshots.recordToday({ ...base, sourceUpdate: { raw: "new stamp" }, rows: [{ store: "1" }], partial: true });
  saved = (await snapshots.read()).today;
  assert.equal(saved.rows.length, 1, "never mix different source versions");
  assert.equal(saved.partial, true);
});
