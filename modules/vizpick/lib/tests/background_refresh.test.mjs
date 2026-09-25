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

test("a per-store check keeps the rows it did not re-read; only another market empties the snapshot", async () => {
  // Stores publish on their own clocks (2026-09-15): a crawl that re-reads
  // only the stores whose own stamp moved must not drop the ones it confirmed,
  // even though the crawl-level stamp it read on the primary tab has changed.
  const db = {};
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(db),
    set: async (obj) => Object.assign(db, structuredClone(obj)),
  } } };
  const su = (iso) => ({ raw: iso.replace("T", " "), iso, hasTime: true });
  await snapshots.recordToday({
    sourceUpdate: su("2026-09-15T14:03:00"), market: "120", capturedAt: "2026-09-15T14:10:00", partial: false,
    rows: [
      { store: "1458", sourceUpdate: su("2026-09-15T14:03:00"), capturedAt: "2026-09-15T14:10:00" },
      { store: "3660", sourceUpdate: su("2026-09-15T13:03:00"), capturedAt: "2026-09-15T14:11:00" },
    ],
  });
  let saved = (await snapshots.read()).today;
  assert.equal(saved.sourceUpdate.iso, "2026-09-15T14:03:00", "snapshot stamp is the newest row stamp");

  // 3660 republished; 1458 did not. The primary tab happened to read 15:03.
  await snapshots.confirmTodayRow({ store: "1458", confirmedAt: "2026-09-15T15:30:00", sourceUpdate: su("2026-09-15T14:03:00"), market: "120" });
  await snapshots.mergeToday({
    sourceUpdate: su("2026-09-15T15:03:00"), market: "120", capturedAt: "2026-09-15T15:31:00", partial: true,
    rows: [{ store: "3660", sourceUpdate: su("2026-09-15T15:03:00"), capturedAt: "2026-09-15T15:31:00" }],
  });
  saved = (await snapshots.read()).today;
  assert.deepEqual(saved.rows.map((r) => r.store).sort(), ["1458", "3660"], "the confirmed store survives a changed crawl-level stamp");
  const r1458 = saved.rows.find((r) => r.store === "1458");
  assert.equal(r1458.sourceUpdate.iso, "2026-09-15T14:03:00", "the confirmed row keeps its own stamp");
  assert.equal(r1458.capturedAt, "2026-09-15T14:10:00", "confirming does not move the capture time");
  assert.equal(r1458.confirmedAt, "2026-09-15T15:30:00");
  assert.equal(saved.rows.find((r) => r.store === "3660").sourceUpdate.iso, "2026-09-15T15:03:00");
  assert.equal(saved.sourceUpdate.iso, "2026-09-15T15:03:00");
  assert.equal(saved.partial, false, "a check against a complete snapshot leaves it complete");

  // A row written before per-store stamps takes the stamp it is confirmed at.
  await snapshots.mergeToday({ sourceUpdate: su("2026-09-15T15:03:00"), market: "120", capturedAt: "2026-09-15T15:32:00", partial: true, rows: [{ store: "669" }] });
  await snapshots.confirmTodayRow({ store: "669", confirmedAt: "2026-09-15T16:00:00", sourceUpdate: su("2026-09-15T15:03:00"), market: "120" });
  assert.equal((await snapshots.read()).today.rows.find((r) => r.store === "669").sourceUpdate.iso, "2026-09-15T15:03:00");
  // A confirmation for another market touches nothing.
  await snapshots.confirmTodayRow({ store: "1458", confirmedAt: "2026-09-15T17:00:00", market: "323" });
  assert.equal((await snapshots.read()).today.rows.find((r) => r.store === "1458").confirmedAt, "2026-09-15T15:30:00");

  await snapshots.mergeToday({ sourceUpdate: su("2026-09-15T15:03:00"), market: "323", capturedAt: "2026-09-15T15:40:00", partial: true, rows: [{ store: "999" }] });
  saved = (await snapshots.read()).today;
  assert.deepEqual(saved.rows.map((r) => r.store), ["999"], "a different market replaces the rows");
  assert.equal(saved.market, "323");
});

test("a full re-read that gets no answer from a store keeps that store's previous row", async () => {
  // 2026-09-15 15:53: nothing was known to check against, so the crawl was a
  // full read; Tableau dropped the Store-parameter Enter for 2 of 10 stores,
  // and because the first write REPLACED the snapshot those two stores
  // vanished from the market. Merge instead: the stale row, under its own
  // older stamp, stands until the store answers again.
  const db = {};
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(db),
    set: async (obj) => Object.assign(db, structuredClone(obj)),
  } } };
  const su = (iso) => ({ raw: iso.replace("T", " "), iso, hasTime: true });
  await snapshots.mergeToday({
    sourceUpdate: su("2026-09-15T14:03:00"), market: "120", capturedAt: "2026-09-15T14:10:00", partial: false,
    rows: [
      { store: "1089", sourceUpdate: su("2026-09-15T14:03:00"), capturedAt: "2026-09-15T14:10:00" },
      { store: "1458", sourceUpdate: su("2026-09-15T14:03:00"), capturedAt: "2026-09-15T14:10:00" },
    ],
  });
  // The full re-read: 1458 answers at 15:03, 1089 never does.
  await snapshots.mergeToday({
    sourceUpdate: su("2026-09-15T15:03:26"), market: "120", capturedAt: "2026-09-15T15:53:00", partial: true,
    rows: [{ store: "1458", sourceUpdate: su("2026-09-15T15:03:26"), capturedAt: "2026-09-15T15:53:00" }],
  });
  let saved = (await snapshots.read()).today;
  assert.deepEqual(saved.rows.map((r) => r.store).sort(), ["1089", "1458"], "the store that did not answer keeps its row");
  assert.equal(saved.rows.find((r) => r.store === "1089").sourceUpdate.iso, "2026-09-15T14:03:00", "under its own older stamp");
  assert.equal(saved.rows.find((r) => r.store === "1458").sourceUpdate.iso, "2026-09-15T15:03:26");
  assert.equal(saved.sourceKey, "2026-09-15 15:03:26");

  // Another market still empties it: those rows are other stores'.
  await snapshots.mergeToday({
    sourceUpdate: su("2026-09-15T15:03:26"), market: "1", capturedAt: "2026-09-15T15:55:00", partial: true,
    rows: [{ store: "1212", sourceUpdate: su("2026-09-15T15:03:26"), capturedAt: "2026-09-15T15:55:00" }],
  });
  saved = (await snapshots.read()).today;
  assert.deepEqual(saved.rows.map((r) => r.store), ["1212"]);
  assert.equal(saved.market, "1");
});
