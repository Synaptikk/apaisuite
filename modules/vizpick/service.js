// modules/vizpick/service.js
//
// SW handlers for vizpick. Two independent captures, because the workbook
// splits the data across two views (see lib/sources/vizpick_today_tableau.js
// for the full rationale):
//
//   pull_stores → views/VizPick/VizPick        — yesterday, every store in
//                 every market, one crosstab export. Fast.
//   pull_today  → views/VizPick/VizPickDetails — current day, ONE store per
//                 export cycle, so a whole market takes minutes. Runs on
//                 demand for any market, and automatically on the alarm for
//                 the home market from Settings > Defaults (see autoCheck).
//
// Captures are stored as versioned snapshots (lib/snapshots.js) whose roll is
// driven by Tableau's own "Last update" stamp rather than the local calendar.

import { ensureAlarm } from "../../shared/alarms.js";
import { keepAwake } from "../../shared/sw_keepalive.js";
import { createLogging } from "../../shared/logging.js";
import { getUserHomeMarket } from "../../shared/userStore.js";
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
//
// Pinned to the ALARM PERIOD, not a shorter figure of its own. This was 10
// minutes back when bootstrapIfNeeded() only ran as the shell mounted the
// module — rare enough that a short gap was harmless. Now that it runs at
// service-worker boot, and the SW boots on essentially every message
// (including the view's own get_state), this gap *is* the effective refresh
// cadence: at 10 minutes it silently overrode AUTO_PERIOD_MIN and ran a
// multi-minute Today crawl three times as often as intended. Two constants
// that both control the same rate must not be allowed to disagree.
const BOOTSTRAP_MIN_GAP_MS = AUTO_PERIOD_MIN * 60_000;

// Opening the suite is a much stronger signal of intent than a service-worker
// wake, so it gets its own, far shorter gap: someone is about to look at this
// data. Not zero, because the shell page can be reloaded repeatedly (and every
// reload of an unpacked extension re-opens it), and each check still has to
// find or open a Tableau tab.
//
// This only became reasonable once the stamp check stopped costing a crosstab
// export — see readSourceStampFromDom(). Before that, an on-open check would
// have driven a full export dialog every time the suite was opened.
const OPEN_CHECK_MIN_GAP_MS = 5 * 60_000;

const AUTO_DEFAULTS = {
  // Yesterday is one cheap export, so following it automatically is free.
  stores: true,
  // Today is two exports PER STORE — minutes for a market — so it is NOT
  // unconditional: autoCheck() only runs it for the home market set in
  // Settings > Defaults, and skips entirely when that is unset. Naming a
  // market there is the opt-in. Without that gate this would quietly crawl
  // whichever market the user last looked at, which is minutes of background
  // Tableau tabs nobody asked for.
  today: true,
};

async function readAuto() {
  const got = await chrome.storage.local.get(K.auto);
  return { ...AUTO_DEFAULTS, ...(got[K.auto] || {}) };
}

// Stamped into every capture envelope. A stored error outlives the code that
// produced it, and we have twice been misled by an old envelope's wording
// after the extension was reloaded — this makes the provenance explicit.
const CAPTURE_BUILD = "2026-08-16d";

// Payload is SPREAD, not nested under a `payload` key. shared/messaging.js's
// on(type, handler) hands the whole flat message to the handler, so nesting
// meant every subscriber received {module, type, payload} and read undefined
// off it. That is why the Today progress bar stayed blank for the first
// minute of a crawl: the today_progress events arrived and rendered nothing,
// and the bar only ever caught up when a today_rows event triggered a full
// repaint that re-read the state from storage. Matches the shared helper and
// every other module.
function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ module: "vizpick", type, ...payload }).catch(() => {});
}

// Telemetry. VizPick emitted NOTHING before 2026-08-22, which is why "the
// auto-refresh isn't running" could only be answered by guessing: autoCheck
// made a decision every 30 minutes and left no trace of it anywhere. Every
// branch below that ends in "do nothing" now says so, so the next occurrence
// diagnoses itself from the Settings debug panel instead of from a hunch.
const log = createLogging("vizpick");

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
    // What the background refresh will actually do, resolved by the same
    // function autoCheck uses. Rendered in the Today bar so "auto-refresh is
    // doing nothing" is always visible rather than silent.
    autoToday:  {
      periodMin: AUTO_PERIOD_MIN,
      // The last silent path: a stored auto.today=false would skip the whole
      // branch with nothing logged and nothing on screen. Surfaced so every
      // reason the refresh might not run is visible in one place.
      enabled: (await readAuto()).today,
      ...resolveAutoTodayMarket(store, await getUserHomeMarket()),
    },
    captureBuild: CAPTURE_BUILD,
    auto:       await readAuto(),
  };
}

async function pullStores(msg) {
  await freshness.startAttempt("stores");
  // Hold the worker up for the duration. Without this the capture dies ~30s
  // after the suite tab is closed or navigated away — see shared/sw_keepalive.js.
  const releaseAwake = keepAwake("vizpick.pullStores");
  try {
    // Hand the capture the stamp we already hold so it can skip the export
    // entirely when Tableau has not republished. `force` bypasses the check.
    const store = await snapshots.read();
    const result = await fetchVizpickStoresTableau({
      knownSourceKey: store.days?.[0]?.sourceKey ?? null,
      force: !!msg?.force,
      auto: !!msg?.auto,
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
  } finally {
    releaseAwake();
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
  // The Today crawl runs for minutes. It happens to survive today only because
  // it polls chrome.tabs/chrome.scripting constantly, which resets the idle
  // timer by accident — this makes it deliberate rather than lucky.
  const releaseAwake = keepAwake("vizpick.pullToday");

  try {
    // A full crawl (changed stamp) must REPLACE the stale rows on its first
    // write; every later write merges. A top-up merges from the start, since
    // the rows it is adding to are still valid at the same stamp.
    let replacedOnce = false;

    const result = await fetchVizpickTodayTableau(stores, {
      knownSourceKey,
      // Lets the source enforce a maximum staleness even when the stamp claims
      // nothing changed — see MAX_TODAY_AGE_MS.
      knownCapturedAt: snapStore.today?.capturedAt ?? null,
      coveredStores,
      force: !!msg?.force,
      auto: !!msg?.auto,
      // Only ever set by dev/test-vizpick-lanes.mjs, which measures the crawl
      // at 1 lane vs 3. Unset in normal use, so the source picks its default.
      concurrency: msg?.concurrency,
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
      // `debug.failures` carries the PER-STORE reason and was previously
      // dropped here, so a total failure reported "no data for any of the 10
      // stores" with no way to see why without digging into storage.
      return {
        ok: false, sourceId: "today",
        errorClass: result.errorClass, error: result.error,
        debug: result.debug ?? null,
      };
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
        // Carried through so the telemetry can show WHY it skipped.
        stampRead: result.stampRead ?? null,
        stampReadVia: result.stampReadVia ?? null,
        stampKnown: result.stampKnown ?? null,
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
      // A PARTIAL success is the interesting case here: ok:true with fewer
      // rows than stores asked for. Without the per-store reasons that reads
      // as a silent shortfall — the caller (and the debug panel) can't tell a
      // row-level-security gap from a broken export.
      debug: result.debug ?? null,
    };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("today", err);
    broadcast("source_complete", { sourceId: "today", ok: false, error: err });
    return { ok: false, sourceId: "today", error: err };
  } finally {
    todayRun = null;
    releaseAwake();
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
// In-flight guard for autoCheck. Now that bootstrapIfNeeded() runs at SW top
// level, a single wake can start two checks: the import-time bootstrap, and
// the onAlarm handler that caused the wake in the first place. pullToday()
// has its own `todayRun` guard, but pullStores() does not — two concurrent
// stores captures would drive the same Tableau tab and fight over the export
// dialog. Coalesce instead: the second caller awaits the first's result.
let autoCheckRun = null;

function autoCheck(reason) {
  if (autoCheckRun) return autoCheckRun.then((r) => ({ ...r, coalescedInto: r.reason, reason }));
  autoCheckRun = _autoCheck(reason).finally(() => { autoCheckRun = null; });
  return autoCheckRun;
}

async function _autoCheck(reason) {
  const auto = await readAuto();
  log.emit("autocheck-start", { reason, stores: auto.stores, today: auto.today });
  if (!auto.stores && !auto.today) {
    log.emit("autocheck-skip", { reason: "both toggles off" });
    return { ok: true, skipped: "auto-refresh off" };
  }

  // Stamp the attempt BEFORE doing the work, not after. A capture can run for
  // a minute or fail outright; recording it only on success meant a slow or
  // erroring run left the rate-limit unset, so every subsequent SW wake would
  // start another one.
  await chrome.storage.local.set({ [K.lastAuto]: Date.now() });

  const out = { reason, stores: null, today: null };

  if (auto.stores) {
    out.stores = await pullStores({ auto: true });
    log.emit("autocheck-stores", {
      ok: !!out.stores?.ok, unchanged: !!out.stores?.unchanged,
      rows: out.stores?.storeCount ?? null, error: out.stores?.error ?? null,
    });
  } else {
    log.emit("autocheck-skip", { which: "stores", reason: "toggle off" });
  }

  if (auto.today) {
    const store = await snapshots.read();
    const homeMarket = await getUserHomeMarket();
    const plan = resolveAutoTodayMarket(store, homeMarket);
    // The whole decision, in one line, including the inputs. A roster of 0 with
    // a home market set is the case that looks most like "it just doesn't
    // work" — usually the Yesterday capture has not succeeded yet, or the
    // market string does not match the roster's spelling.
    log.emit("autocheck-today-plan", {
      homeMarket: homeMarket ?? null,
      snapshotMarket: store?.today?.market ?? null,
      resolved: plan.market, source: plan.source,
      storeCount: plan.stores.length,
      rosterDays: store?.days?.length ?? 0,
      rosterRows: store?.days?.[0]?.rows?.length ?? 0,
      reason: plan.reason,
    });
    if (plan.market) {
      out.today = await pullToday({ stores: plan.stores, market: plan.market, auto: true });
      // On failure the useful part is WHICH stage failed, per store — a bare
      // "captured nothing for any of 10" is not actionable. Reasons are
      // deduplicated because 10 stores failing the same way is one fact, not
      // ten, and the ring is 500 entries.
      const failures = out.today?.debug?.failures || [];
      const reasonCounts = {};
      for (const f of failures) {
        const key = String(f?.reason ?? "unknown").slice(0, 120);
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
      log.emit("autocheck-today", {
        ok: !!out.today?.ok, unchanged: !!out.today?.unchanged,
        // The two values the skip decision was made from. "unchanged" with
        // these absent is an assertion; with them it is evidence.
        stampRead: out.today?.stampRead ?? null,
        stampReadVia: out.today?.stampReadVia ?? null,
        stampKnown: out.today?.stampKnown ?? null,
        captured: out.today?.storeCount ?? null,
        requested: out.today?.requested ?? null,
        errorClass: out.today?.errorClass ?? null,
        error: out.today?.error ?? null,
        failureCount: failures.length,
        reasons: reasonCounts,
      });
    } else {
      out.today = { ok: true, skipped: plan.reason };
    }
  } else {
    log.emit("autocheck-skip", { which: "today", reason: "toggle off" });
  }

  return { ok: true, ...out };
}

/**
 * Which market should the background Today refresh follow, and why not, if not.
 *
 * Shared by autoCheck() and get_state so the UI can never disagree with what
 * the service worker will actually do. That mattered: the first version of
 * this gated on the home market alone and, when unset, returned silently. The
 * whole feature then did nothing with no indication anywhere on screen, which
 * is indistinguishable from it being broken — and was reported as exactly that.
 *
 * Order:
 *   1. Home market from Settings > Defaults. Explicit, survives browsing a
 *      peer market, and works on a profile that has never crawled Today.
 *   2. Otherwise the market of the stored Today snapshot. Loading a market by
 *      hand IS a request for that market, so following it is not "crawling a
 *      market nobody asked for" — the objection that motivated the original
 *      gate. It only ever follows something the user themselves loaded.
 *
 * Pure apart from the two values passed in, so it is trivially testable.
 */
export function resolveAutoTodayMarket(store, homeMarket) {
  const market = homeMarket || store?.today?.market || null;
  if (!market) {
    return {
      market: null, stores: [], source: null,
      reason: "no market to follow — set a home market in Settings > Defaults, or load Today for a market once",
    };
  }
  const source = homeMarket ? "home-market" : "last-loaded";
  // String-compared because the home market is stored exactly as typed
  // (shared/userStore.js: "0120" must not become "120").
  const stores = (store?.days?.[0]?.rows || [])
    .filter((r) => String(r.market) === String(market))
    .map((r) => r.store);
  if (!stores.length) {
    return {
      market: null, stores: [], source,
      // Either the Yesterday capture has not run yet, or the market string is
      // not in it. Both look identical from the UI, so name which.
      reason: `market ${market} has no stores in the Yesterday roster yet — refresh Yesterday first`,
    };
  }
  return { market, stores, source, reason: null };
}

/**
 * "The suite was just opened" — check now rather than waiting up to 30 minutes
 * for the next alarm.
 *
 * Called via the generic `suite_opened` handler the shell dispatches to any
 * module that implements one (see app.js). The shell does not know this module
 * exists, which is the point: another module wanting the same behaviour adds
 * the handler and nothing in the shell changes.
 *
 * Cheap in the common case: autoCheck reads Tableau's Updated stamp and stops
 * there unless it has moved.
 */
export async function openCheck() {
  try {
    const got = await chrome.storage.local.get(K.lastAuto);
    const sinceMs = Date.now() - (got[K.lastAuto] || 0);
    if (sinceMs < OPEN_CHECK_MIN_GAP_MS) {
      log.emit("open-check-skip", { sinceMs, gapMs: OPEN_CHECK_MIN_GAP_MS });
      return { ok: true, skipped: "checked recently" };
    }
    log.emit("open-check", { sinceMs });
    // Not awaited by the caller: the shell must not wait on Tableau to finish
    // painting its first route.
    return await autoCheck("suite-opened");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Registered from module.js at top level — MV3 requires that for SW wake. */
export async function onAlarm(alarm) {
  if (alarm?.name !== ALARM_NAMES.autocheck) return;
  // Proves the alarm actually fires. Its absence from the feed is itself the
  // diagnosis — that was the 2026-08-20 bug, and nothing recorded it then.
  log.emit("alarm-fired", { name: alarm.name });
  try { await autoCheck("alarm"); }
  catch (e) { console.warn("[vizpick] auto-check failed:", e?.message ?? e); }
}

/**
 * Idempotent — safe to call on every SW boot. See shared/alarms.js for why
 * chrome.alarms.create() on its own is not.
 *
 * delayInMinutes: 1 rather than the default full period — a freshly installed
 * alarm should get the cards current within a minute, not sit idle for half
 * an hour. The check it runs is cheap when Tableau has not republished.
 */
export async function installAlarms() {
  const r = await ensureAlarm(ALARM_NAMES.autocheck, {
    periodInMinutes: AUTO_PERIOD_MIN,
    delayInMinutes: 1,
  });
  log.emit("alarm-ensured", { created: r.created, reason: r.reason, periodMin: AUTO_PERIOD_MIN });
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
    const sinceMs = Date.now() - last;
    if (sinceMs < BOOTSTRAP_MIN_GAP_MS) {
      log.emit("bootstrap-skip", { sinceMs, gapMs: BOOTSTRAP_MIN_GAP_MS });
      return { ok: true, skipped: "checked recently" };
    }
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

  // Dispatched by the shell when the suite page opens. Any module may
  // implement this; the shell looks for the handler rather than knowing which
  // modules want it.
  async "suite_opened"(_msg) { return await openCheck(); },

  // Everything needed to diagnose a failing capture WITHOUT asking the user to
  // open DevTools and read raw storage. Three rounds of this bug were spent
  // guessing at a profile we cannot see; one paste of this ends that.
  //
  // Deliberately carries no store-level business data — counts, stamps, error
  // classes and the state of the Tableau tabs, nothing more.
  async "diagnostics"(msg) {
    const [got, store, auto, lastAuto] = await Promise.all([
      chrome.storage.local.get([K.debug, K.debugToday]),
      snapshots.read(),
      readAuto(),
      chrome.storage.local.get(K.lastAuto),
    ]);

    // The tabs the capture would find and reuse. A stale or discarded one here
    // is the single most common cause of a capture that fails identically on
    // every retry.
    let tabs = [];
    try {
      tabs = (await chrome.tabs.query({ url: "https://stores.tableau.wal-mart.com/*" }))
        .map((t) => ({
          view: /\/views\/VizPick\/(\w+)/i.exec(t.url || "")?.[1] ?? "(none)",
          status: t.status, discarded: !!t.discarded, active: !!t.active,
          frozen: !!t.frozen, audible: !!t.audible,
        }));
    } catch (e) { tabs = [{ error: String(e?.message ?? e) }]; }

    const market = msg?.market != null ? String(msg.market) : null;
    const roster = store.days?.[0]?.rows || [];
    const inMarket = market ? roster.filter((r) => String(r.market) === market) : [];

    return {
      ok: true,
      build: CAPTURE_BUILD,
      generatedAt: new Date().toISOString(),
      schemaVersion: snapshots.SCHEMA_VERSION,
      // Only what this module needs — the full grant list runs to ~50 hosts
      // and buries the answer in whatever gets pasted.
      permissions: await (async () => {
        const p = await chrome.permissions.getAll().catch(() => null);
        if (!p) return null;
        const need = ["storage", "tabs", "scripting", "alarms"];
        return {
          tableauHost: (p.origins || []).includes("https://stores.tableau.wal-mart.com/*"),
          missing: need.filter((n) => !(p.permissions || []).includes(n)),
        };
      })(),

      // What the UI thinks it is asking for. A market whose type or value does
      // not match the roster yields an empty store list and a capture that
      // "does nothing" with no error at all.
      request: {
        market,
        marketType: typeof msg?.market,
        // What the background auto-refresh will follow for Today. Unset here
        // means the Today auto-crawl skips every run and does so silently,
        // which is otherwise indistinguishable from a broken capture.
        homeMarket: await getUserHomeMarket().catch(() => null),
        storesInMarket: inMarket.length,
        sampleStores: inMarket.slice(0, 5).map((r) => r.store),
        rosterMarketSample: [...new Set(roster.slice(0, 400).map((r) => typeof r.market))],
      },

      stored: {
        days: (store.days || []).map((d) => ({ dataDate: d.dataDate, rows: d.rows?.length ?? 0, sourceKey: d.sourceKey })),
        today: store.today ? {
          rows: store.today.rows?.length ?? 0, market: store.today.market,
          sourceKey: store.today.sourceKey, partial: !!store.today.partial,
          capturedAt: store.today.capturedAt,
        } : null,
      },

      auto: { ...auto, lastRun: lastAuto?.[K.lastAuto] ?? null },

      tableauTabs: tabs,
      lastError: { stores: got[K.debug] ?? null, today: got[K.debugToday] ?? null },
      freshness: {
        stores: await freshness.read("stores").catch(() => null),
        today:  await freshness.read("today").catch(() => null),
      },
    };
  },
  async "dismiss_error"(msg) {
    await chrome.storage.local.remove(msg?.sourceId === "today" ? K.debugToday : K.debug);
    return { ok: true };
  },
  async "pull_stores"(msg)   { return await pullStores(msg); },
  async "pull_today"(msg)    { return await pullToday(msg); },
  async "cancel_today"(_msg) { return cancelToday(); },
};
