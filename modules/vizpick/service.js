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
  auto:       "vizpick.auto.v1",
  lastAuto:   "vizpick.auto.lastRun",
};

// Auto-check cadence. The check itself is cheap — it exports only Tableau's
// tiny "Last update" sheet and returns unchanged:true without touching the
// stored snapshot — so polling costs seconds, and the expensive export only
// happens on a run where the stamp actually moved.
export const ALARM_NAMES = { autocheck: "vizpick.autocheck" };
const AUTO_PERIOD_MIN = 30;

// Don't re-check on every service-worker wake. MV3 boots the SW for all sorts
// of reasons; without this a busy browser would drive Tableau constantly.
const BOOTSTRAP_MIN_GAP_MS = 10 * 60_000;

const AUTO_DEFAULTS = {
  // Yesterday is one cheap export, so following it automatically is free.
  stores: true,
  // Today is two exports PER STORE — minutes for a market — so it stays
  // opt-in rather than something the browser does to you in the background.
  today: false,
};

async function readAuto() {
  const got = await chrome.storage.local.get(K.auto);
  return { ...AUTO_DEFAULTS, ...(got[K.auto] || {}) };
}

// Stamped into every capture envelope. A stored error outlives the code that
// produced it, and we have twice been misled by an old envelope's wording
// after the extension was reloaded — this makes the provenance explicit.
const CAPTURE_BUILD = "2026-08-16c";

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

  const y = store.days[0] || null;   // newest closed day
  return {
    ok: true,
    schemaVersion: snapshots.SCHEMA_VERSION,
    maxDays: snapshots.MAX_DAYS,

    // Back-compat: the pre-tabs view read state.rows / state.grandTotal.
    rows:       y?.rows || [],
    grandTotal: y?.grandTotal || null,

    // Rolling history, newest first. `yesterday` stays as an alias for the
    // newest closed day so nothing that reads it has to change.
    days:      store.days || [],
    yesterday: y || null,
    today:     store.today || null,

    freshness:      freshStores,
    todayFreshness: freshToday,
    todayProgress:  todayRun ? { ...todayRun.progress } : null,

    debug:      got[K.debug] || null,
    debugToday: got[K.debugToday] || null,
    captureBuild: CAPTURE_BUILD,
    auto:       await readAuto(),
  };
}

async function pullStores(msg) {
  await freshness.startAttempt("stores");
  try {
    // Hand the capture the stamp we already hold so it can skip the export
    // entirely when Tableau has not republished. `force` bypasses the check.
    const store = await snapshots.read();
    const result = await fetchVizpickStoresTableau({
      knownSourceKey: store.days?.[0]?.sourceKey ?? null,
      force: !!msg?.force,
      onPhase: (p) => broadcast("capture_phase", { sourceId: "stores", phase: p }),
    });

    await chrome.storage.local.set({
      [K.debug]: {
        build:      CAPTURE_BUILD,
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

    // Nothing new upstream: leave the stored snapshot completely untouched
    // (rows, grandTotal and the previous-day history all stay as they are) and
    // only record that we checked.
    if (result.unchanged) {
      await freshness.markSuccess("stores");
      broadcast("source_complete", { sourceId: "stores", ok: true, unchanged: true });
      return {
        ok: true, sourceId: "stores", unchanged: true,
        sourceUpdate: result.sourceUpdate ?? null,
        storeCount: store.days?.[0]?.rows?.length ?? 0,
      };
    }

    const { rolled, reason, dayCount } = await snapshots.recordYesterday({
      rows:         result.rows,
      grandTotal:   result.grandTotal,
      sourceUpdate: result.sourceUpdate,
      capturedAt:   result.capturedAt,
    });

    await freshness.markSuccess("stores");
    broadcast("source_complete", { sourceId: "stores", ok: true, rolled, auto: !!msg?.auto });
    return { ok: true, sourceId: "stores", storeCount: result.rows.length, rolled, rollReason: reason, dayCount };
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

  // Only reuse the stored stamp when it belongs to the SAME market — a
  // different market needs a different set of stores regardless of how fresh
  // the timestamp is. todayIsCurrent() enforces that.
  const snapStore = await snapshots.read();
  const knownSourceKey = snapshots.todayIsCurrent(snapStore, snapStore.today?.sourceKey, market)
    ? snapStore.today.sourceKey
    : null;
  // Which stores that stamp actually covers. Without this the capture treats a
  // partial snapshot as complete and never fetches the stores it is missing.
  const coveredStores = knownSourceKey ? snapshots.todayCoveredStores(snapStore, market) : [];

  todayRun = { cancelled: false, progress: { done: 0, total: stores.length, store: null } };
  await freshness.startAttempt("today");

  try {
    // A full crawl (changed stamp) must REPLACE the stale rows on its first
    // write; every later write merges. A top-up merges from the start, since
    // the rows it is adding to are still valid at the same stamp.
    let replacedOnce = false;

    const result = await fetchVizpickTodayTableau(stores, {
      knownSourceKey,
      coveredStores,
      force: !!msg?.force,
      onStore: async ({ row, sourceUpdate, topUp }) => {
        const payload = {
          rows: [row],
          sourceUpdate,
          capturedAt: new Date().toISOString(),
          partial: true,            // still mid-crawl
          market,
        };
        if (!topUp && !replacedOnce) {
          await snapshots.recordToday(payload);
          replacedOnce = true;
        } else {
          await snapshots.mergeToday(payload);
        }
        // Tells the view to re-read state and paint the card now.
        broadcast("today_rows", { store: row.store });
      },
      onProgress: (p) => {
        if (!todayRun) return;
        todayRun.progress = p;
        broadcast("today_progress", p);
      },
      isCancelled: () => !!todayRun?.cancelled,
    });

    await chrome.storage.local.set({
      [K.debugToday]: {
        build:      CAPTURE_BUILD,
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

    // Upstream hasn't republished since this market's stored crawl — skip the
    // multi-minute walk and keep what we have.
    if (result.unchanged) {
      await freshness.markSuccess("today");
      broadcast("source_complete", { sourceId: "today", ok: true, unchanged: true });
      return {
        ok: true, sourceId: "today", unchanged: true,
        sourceUpdate: result.sourceUpdate ?? null,
        storeCount: snapStore.today?.rows?.length ?? 0,
      };
    }

    // A top-up visited only the missing stores, so merge rather than replace.
    const persist = result.topUp ? snapshots.mergeToday : snapshots.recordToday;
    await persist({
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
      toppedUp: !!result.topUp,
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

/**
 * Periodic + on-boot check. Deliberately reuses the ordinary pull paths: both
 * already read Tableau's "Last update" stamp first and return unchanged:true
 * without re-exporting, so "poll for a new timestamp and only then update" is
 * exactly what calling them does. Nothing new to keep in sync.
 */
async function autoCheck(reason) {
  const auto = await readAuto();
  if (!auto.stores && !auto.today) return { ok: true, skipped: "auto-refresh off" };

  // Stamp the attempt BEFORE doing the work, not after. A capture can run for
  // a minute or fail outright; recording it only on success meant a slow or
  // erroring run left the rate-limit unset, so every subsequent SW wake would
  // start another one.
  await chrome.storage.local.set({ [K.lastAuto]: Date.now() });

  const out = { reason, stores: null, today: null };

  if (auto.stores) {
    out.stores = await pullStores({ auto: true });
  }

  if (auto.today) {
    // Only ever re-crawl a market we already hold, and take its store list
    // from the yesterday roster — the same list the UI would send.
    const store = await snapshots.read();
    const market = store.today?.market ?? null;
    if (market) {
      const roster = (store.days?.[0]?.rows || [])
        .filter((r) => String(r.market) === String(market))
        .map((r) => r.store);
      if (roster.length) out.today = await pullToday({ stores: roster, market, auto: true });
    }
  }

  return { ok: true, ...out };
}

/** Registered from module.js at top level — MV3 requires that for SW wake. */
export async function onAlarm(alarm) {
  if (alarm?.name !== ALARM_NAMES.autocheck) return;
  try { await autoCheck("alarm"); }
  catch (e) { console.warn("[vizpick] auto-check failed:", e?.message ?? e); }
}

/** Idempotent — safe to call on every SW boot. */
export async function installAlarms() {
  await chrome.alarms.create(ALARM_NAMES.autocheck, { periodInMinutes: AUTO_PERIOD_MIN });
}

/**
 * Runs when the service worker boots, which includes every browser start —
 * so the cards are already current by the time the module is opened, instead
 * of showing yesterday's capture until someone clicks Refresh. Rate-limited
 * because the SW wakes for many reasons besides a browser start.
 */
export async function bootstrapIfNeeded() {
  try {
    const got = await chrome.storage.local.get(K.lastAuto);
    const last = got[K.lastAuto] || 0;
    if (Date.now() - last < BOOTSTRAP_MIN_GAP_MS) return { ok: true, skipped: "checked recently" };
    return await autoCheck("bootstrap");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export const handlers = {
  async "get_state"(_msg)    { return await getState(); },
  // Clear a stored capture error without running anything.
  async "set_auto"(msg) {
    const auto = { ...(await readAuto()), ...(msg?.auto || {}) };
    await chrome.storage.local.set({ [K.auto]: auto });
    // Turning Today's auto-refresh on shouldn't wait up to 30 minutes to do
    // anything, so kick a check immediately.
    if (msg?.checkNow) autoCheck("toggled").catch(() => {});
    return { ok: true, auto };
  },
  async "auto_check_now"(_msg) { return await autoCheck("manual"); },
  async "dismiss_error"(msg) {
    await chrome.storage.local.remove(msg?.sourceId === "today" ? K.debugToday : K.debug);
    return { ok: true };
  },
  async "pull_stores"(msg)   { return await pullStores(msg); },
  async "pull_today"(msg)    { return await pullToday(msg); },
  async "cancel_today"(_msg) { return cancelToday(); },
};
