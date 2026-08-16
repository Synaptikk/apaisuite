// modules/vizpick/service.js
//
// SW handlers for vizpick. Two independent captures, because the workbook
// splits the data across two views (see lib/sources/vizpick_today_tableau.js
// for the full rationale):
//
//   pull_stores → views/VizPick/VizPick        — yesterday, every store in
//                 every market, one crosstab export. Fast.
//   pull_today  → views/VizPick/VizPickDetails — current day, ONE store per
//                 export cycle, so it is on-demand and takes minutes for a
//                 whole market.
//
// Captures are stored as versioned snapshots (lib/snapshots.js) whose roll is
// driven by Tableau's own "Last update" stamp rather than the local calendar.

import * as freshness from "./lib/freshness.js";
import * as snapshots from "./lib/snapshots.js";
import { fetchVizpickStoresTableau } from "./lib/sources/vizpick_stores_tableau.js";
import { fetchVizpickTodayTableau } from "./lib/sources/vizpick_today_tableau.js";

const K = {
  debug:      "vizpick.debug.stores",
  debugToday: "vizpick.debug.today",
};

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: "vizpick", type, payload }).catch(() => {});
}

// Guards against two overlapping Today crawls (each drives a shared Tableau
// tab, so concurrent runs would fight over the Store parameter).
let todayRun = null;

async function getState() {
  const [got, freshStores, freshToday, store] = await Promise.all([
    chrome.storage.local.get([K.debug, K.debugToday]),
    freshness.read("stores"),
    freshness.read("today"),
    snapshots.read(),
  ]);

  const y = store.yesterday;
  return {
    ok: true,
    schemaVersion: snapshots.SCHEMA_VERSION,

    // Back-compat: the pre-tabs view read state.rows / state.grandTotal.
    rows:       y?.rows || [],
    grandTotal: y?.grandTotal || null,

    yesterday: y || null,
    previous:  store.previous || null,
    today:     store.today || null,

    freshness:      freshStores,
    todayFreshness: freshToday,
    todayProgress:  todayRun ? { ...todayRun.progress } : null,

    debug:      got[K.debug] || null,
    debugToday: got[K.debugToday] || null,
  };
}

async function pullStores() {
  await freshness.startAttempt("stores");
  try {
    const result = await fetchVizpickStoresTableau();

    await chrome.storage.local.set({
      [K.debug]: {
        ok:         result.ok,
        errorClass: result.errorClass || null,
        error:      result.error || null,
        debug:      result.debug || null,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      // A failed capture must not silently discard a good stored snapshot —
      // the freshness error state is what tells the UI something is wrong,
      // and keeping the last known-good rows on screen beats a blank page.
      await freshness.markError("stores", `${result.errorClass}: ${result.error}`);
      broadcast("source_complete", { sourceId: "stores", ok: false, error: result.error });
      return { ok: false, sourceId: "stores", errorClass: result.errorClass, error: result.error };
    }

    const { rolled, reason } = await snapshots.recordYesterday({
      rows:         result.rows,
      grandTotal:   result.grandTotal,
      sourceUpdate: result.sourceUpdate,
      capturedAt:   result.capturedAt,
    });

    await freshness.markSuccess("stores");
    broadcast("source_complete", { sourceId: "stores", ok: true, rolled });
    return { ok: true, sourceId: "stores", storeCount: result.rows.length, rolled, rollReason: reason };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("stores", err);
    broadcast("source_complete", { sourceId: "stores", ok: false, error: err });
    return { ok: false, sourceId: "stores", error: err };
  }
}

async function pullToday(msg) {
  if (todayRun) {
    return { ok: false, errorClass: "BUSY", error: "A Today capture is already running.", progress: { ...todayRun.progress } };
  }

  const stores = Array.isArray(msg?.stores) ? msg.stores : [];
  const market = msg?.market ?? null;
  if (!stores.length) {
    return { ok: false, errorClass: "INPUT", error: "No stores supplied for the Today capture." };
  }

  todayRun = { cancelled: false, progress: { done: 0, total: stores.length, store: null } };
  await freshness.startAttempt("today");

  try {
    const result = await fetchVizpickTodayTableau(stores, {
      onProgress: (p) => {
        if (!todayRun) return;
        todayRun.progress = p;
        broadcast("today_progress", p);
      },
      isCancelled: () => !!todayRun?.cancelled,
    });

    await chrome.storage.local.set({
      [K.debugToday]: {
        ok:         result.ok,
        errorClass: result.errorClass || null,
        error:      result.error || null,
        debug:      result.debug || null,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      await freshness.markError("today", `${result.errorClass}: ${result.error}`);
      broadcast("source_complete", { sourceId: "today", ok: false, error: result.error });
      return { ok: false, sourceId: "today", errorClass: result.errorClass, error: result.error };
    }

    await snapshots.recordToday({
      rows:         result.rows,
      sourceUpdate: result.sourceUpdate,
      capturedAt:   result.capturedAt,
      partial:      result.partial,
      market,
    });

    await freshness.markSuccess("today");
    broadcast("source_complete", { sourceId: "today", ok: true });
    return {
      ok: true,
      sourceId: "today",
      storeCount: result.rows.length,
      requested: stores.length,
      partial: result.partial,
    };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("today", err);
    broadcast("source_complete", { sourceId: "today", ok: false, error: err });
    return { ok: false, sourceId: "today", error: err };
  } finally {
    todayRun = null;
  }
}

function cancelToday() {
  if (!todayRun) return { ok: false, error: "No Today capture is running." };
  todayRun.cancelled = true;
  return { ok: true };
}

export const handlers = {
  async "get_state"(_msg)    { return await getState(); },
  async "pull_stores"(_msg)  { return await pullStores(); },
  async "pull_today"(msg)    { return await pullToday(msg); },
  async "cancel_today"(_msg) { return cancelToday(); },
};
