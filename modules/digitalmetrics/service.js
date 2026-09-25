// modules/digitalmetrics/service.js
//
// SW-side handlers. All Firestore access lives here so the view never holds a
// token and never builds a request. Handlers take and return plaintext names;
// lib/firestore.js does the encoding.
//
// Reminder (MODULE_CONTRACT §4): `host` does not exist in a service worker.
// Use raw chrome.storage.* with a manual "digitalmetrics." prefix.

import { store, weeks, classifications, schedules, assignments, suggestions } from "./lib/firestore.js";
import { loadAliases, aliasCount } from "./lib/names.js";
import { splitByStoreWeek } from "./lib/data/parse.js";
import { dayName, isFinalized } from "./lib/data/grid.js";
import { pivotAssociateData } from "./lib/data/tableau.js";
import { pullMetrics } from "./lib/sources/tableau_metrics.js";
import { pullExpressDay } from "./lib/sources/tableau_express.js";
import { mergeWeekDoc, expressPickRates } from "./lib/data/express.js";
import { weekKey } from "./lib/data/weeks.js";
import { pullSchedule } from "./lib/sources/wfm_schedule.js";
import { datesToPull, isPullDue, isoDay } from "./lib/pull_schedule.js";
import { getUserHomeStore, getUserHomeMarket } from "../../shared/userStore.js";
import { getMarketRoster, listKnownMarkets } from "../../shared/marketRoster.js";
import { ensureAlarm } from "../../shared/alarms.js";
import { withTableauLock } from "../../shared/tableau_lock.js";
import { fetchDailyBoard } from "./lib/sources/daily_board_source.js";
import { pullClockIns } from "./lib/sources/gta_timesheet.js";
import { clockInCandidates } from "./lib/data/first_pick.js";
import {
  parseShareLink, weekdaySheets, planDates, resolveBoardNames, mergeBoard, scheduleFit, learnFromHistory,
  localIsoDate, addDays, SNAPSHOT_KEEP_DAYS,
} from "./lib/data/board_sync.js";
import { deriveClassifications, deriveExceptions, isDigitalJob, leadershipForJob } from "./lib/data/job_classify.js";
import { dateKey } from "./lib/data/adherence.js";

const ALIAS_KEY = "digitalmetrics.aliases";

// Automated-pull state. Raw chrome.storage with a manual prefix — `host` does
// not exist in a service worker (MODULE_CONTRACT §4).
const PULL_STATE_KEY = "digitalmetrics.pullState";
const PULL_ENABLED_KEY = "digitalmetrics.pullEnabled";

// Don't re-pull more often than this even if the alarm fires repeatedly. MV3
// restarts the worker constantly, and each pull opens a real background tab
// against a corporate report.
const MIN_PULL_GAP_MS = 45 * 60 * 1000;

// Alarm identity lives beside its installer. module.js only decides WHETHER to
// install (service-worker context only); it does not own the schedule.
export const PULL_ALARM = "digitalmetrics.pull";
const PULL_PERIOD_MIN = 60;

// A run longer than this is not a run, it is a corpse. A typical honest run is
// ~7 min (scheduler 90+90+6 s, Tableau 60+120+6 s for the metrics, then one
// ~20 s tab per Express Pickup day, up to 8 on a first run — see
// lib/sources/*), so anything past this has lost its worker: an extension
// reload or an MV3 termination mid-pull skips runPull's `finally`, and the
// `running: true` it wrote to storage would otherwise wedge every later run
// with "a pull is already running" and pin the pill on "syncing…" for good
// (2026-09-14: 15 minutes of "syncing…" with nothing written).
const PULL_STALE_MS = 25 * 60 * 1000;

async function getPullState() {
  const got = await chrome.storage.local.get(PULL_STATE_KEY);
  const state = got[PULL_STATE_KEY] || { lastRunAt: 0, lastResult: null, running: false };
  if (state.running && Date.now() - (state.runningSince || 0) > PULL_STALE_MS) {
    return abandonRun(state, "the previous run never finished (its worker was likely reloaded mid-pull)");
  }
  return state;
}

/**
 * Mark a run as dead without pretending it completed. Its failure lands in
 * lastResult so the pill reports "1 failed" rather than "synced", and
 * lastRunAt is left alone so the next alarm is not pushed out by a run that
 * did nothing.
 */
async function abandonRun(state, why) {
  const next = {
    ...state,
    running: false,
    runningSince: 0,
    progress: null,
    lastResult: {
      startedAt: state.runningSince ? new Date(state.runningSince).toISOString() : null,
      finishedAt: new Date().toISOString(),
      abandoned: true,
      metrics: [], schedule: null,
      errors: [{ scope: "pull", error: why }],
    },
  };
  await chrome.storage.local.set({ [PULL_STATE_KEY]: next });
  return next;
}

/**
 * Called once per worker boot (module.js, service-worker context only). No
 * JS from a previous worker survives a boot, so a `running` flag found here
 * belongs to a run that can never finish — clear it before the alarm or the
 * shell asks.
 */
export async function resetStaleRun() {
  const got = await chrome.storage.local.get(PULL_STATE_KEY);
  const state = got[PULL_STATE_KEY];
  if (!state?.running) return false;
  await abandonRun(state, "the extension's worker restarted mid-pull");
  return true;
}

/**
 * Where a run is right now. Persisted so a view mounted mid-run can show it,
 * and broadcast so an already-open view updates without polling.
 */
async function setProgress(phase, detail = {}) {
  const progress = { phase, ...detail, at: Date.now() };
  await setPullState({ progress });
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: "pull-progress", progress })
    .catch(() => {});   // nobody listening is the normal case for an alarm run
}

async function setPullState(patch) {
  const cur = await getPullState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [PULL_STATE_KEY]: next });
  return next;
}

/**
 * Automated pulls are OPT-IN and default OFF.
 *
 * Separate from `digitalmetrics.writerEnabled`, which stops writes. This stops
 * the browser automation — opening tabs and driving corporate reports on a
 * timer is not something to start doing to someone by surprise on upgrade.
 */
async function pullEnabled() {
  const got = await chrome.storage.sync.get(PULL_ENABLED_KEY);
  return got[PULL_ENABLED_KEY] === true;
}

/**
 * One store's pull: the Associate By Day metrics (fetch → pivot → split) plus
 * the Express Pickup daily totals (one Tableau load per day), merged into the
 * stored week documents and persisted.
 *
 * The two sources keep separate "what do we have" ledgers, so a week that has
 * its associate rows but no Express numbers yet gets only the Express loads.
 */
async function pullMetricsForStore(storeId, { force = false, onProgress = () => {} } = {}) {
  const now = new Date();
  // Week documents hold rows, not a date index, so "what do we already have"
  // means reading the recent weeks and collecting their distinct dates.
  const have = force
    ? { metrics: [], express: [], expressRate: [], expressOrders: {} }
    : await storedCoverage(storeId).catch(() => ({ metrics: [], express: [], expressRate: [], expressOrders: {} }));
  const dates        = datesToPull(now, have.metrics);
  const expressDates = datesToPull(now, have.express);
  const rateDates    = datesToPull(now, have.expressRate);
  if (!dates.length && !expressDates.length && !rateDates.length) return { store: storeId, skipped: "up to date" };

  // Everything this run will write, keyed by store+week. Metrics groups come
  // from the splitter; Express days attach to the week that contains them.
  const byWeek = new Map();
  const groupFor = (s, wk) => {
    const key = `${s}|${wk}`;
    if (!byWeek.has(key)) {
      byWeek.set(key, { store: s, weekKey: wk, doc: {
        rawData: [], fileName: null, uploadDate: now.toISOString(), store: s, weekStart: wk,
      } });
    }
    return byWeek.get(key);
  };

  // ── Associate By Day ────────────────────────────────────────────────────
  let rows = 0, skipped = 0, pickers = [];
  if (dates.length) {
    const pulled = await pullMetrics(storeId, dates, { onProgress });
    const wide = pivotAssociateData(pulled.rows);
    const split = splitByStoreWeek(wide, { fileName: `auto-pull ${isoDay(now)}` });
    rows = pulled.rows.length;
    skipped = split.skipped;
    for (const g of split.groups) byWeek.set(`${g.store}|${g.weekKey}`, g);

    // Who actually picked. Feeds the Store Help half of the classification rule
    // (see lib/data/job_classify.js) — the roster is ~440 people and only ~150
    // of them appear here.
    pickers = [...new Set(wide.map((r) => String(r.Associate || "").trim().toUpperCase()).filter(Boolean))];
  }

  // ── Express Pickup, one day per tab ─────────────────────────────────────
  //
  // Failures are collected, not thrown: a day that cannot be read must not
  // cost the metrics pull above.
  const express = { pulled: 0, failed: [] };
  if (expressDates.length) {
    const market = await resolveMarket(storeId);
    if (!market) {
      express.failed.push({ date: "*", error:
        `no market known for store ${storeId} — set your market under Settings › Defaults` });
    } else {
      for (const d of expressDates) {
        try {
          const day = await pullExpressDay(storeId, market, d, { onProgress });
          const doc = groupFor(storeId, weekKey(d)).doc;
          doc.express = { ...(doc.express || {}), [d]: day };
          have.expressOrders[d] = day.orders;
          express.pulled++;
        } catch (e) {
          express.failed.push({ date: d, error: String(e?.message ?? e) });
        }
      }
    }
  }

  // ── Express pick rate: Associate By Day filtered to Express Pickup ─────
  //
  // One load for every missing day (the sheet has a Pick Date dimension,
  // unlike the Overview). A day with no Express Pickup has no rows. When the
  // load returned rows for SOME day, the missing ones are real quiet days;
  // when it returned none at all, only days the Overview already recorded as
  // 0 orders can be trusted as zeros — anything else is reported as failed
  // and retried next run.
  if (rateDates.length) {
    try {
      const pulled = await pullMetrics(storeId, rateDates, {
        onProgress, fulfillmentType: "Express Pickup", allowEmpty: true,
      });
      const quiet = rateDates.filter((d) => have.expressOrders[d] === 0);
      const rates = expressPickRates(pulled.rows, { dates: pulled.rows.length ? rateDates : quiet });
      const pulledAt = new Date().toISOString();
      for (const [d, r] of Object.entries(rates)) {
        const doc = groupFor(storeId, weekKey(d)).doc;
        doc.expressRate = { ...(doc.expressRate || {}), [d]: { ...r, pulledAt } };
        express.ratePulled = (express.ratePulled || 0) + 1;
      }
      if (!pulled.rows.length && quiet.length < rateDates.length) {
        express.failed.push({ date: "pick rate", error:
          `Associate By Day (Express Pickup) returned no rows for ` +
          rateDates.filter((d) => !quiet.includes(d)).join(", ") });
      }
    } catch (e) {
      express.failed.push({ date: "pick rate", error: String(e?.message ?? e) });
    }
  }

  // ── Merge into what is stored, then write ───────────────────────────────
  //
  // put() replaces the whole document and this run only fetched SOME dates;
  // writing the slice as-is used to wipe the rest of the week (and would now
  // wipe the Express map too). mergeWeekDoc keeps everything not re-pulled.
  const written = [];
  for (const g of byWeek.values()) {
    const existing = await weeks.get(g.store, g.weekKey).catch(() => null);
    const merged = mergeWeekDoc(existing, g.doc, { dates });
    await weeks.put(g.store, g.weekKey, merged);
    written.push({
      store: g.store, weekKey: g.weekKey,
      rows: merged.rawData.length,
      expressDays: Object.keys(g.doc.express || {}).length,
      expressRateDays: Object.keys(g.doc.expressRate || {}).length,
    });
  }

  // A newly-seen store must reach the store list or it never appears in the UI.
  const knownStores = new Set(await store.listStores());
  const added = [...new Set(written.map((w) => w.store))].filter((s) => !knownStores.has(s));
  if (added.length) await store.saveStores([...knownStores, ...added]);

  return { store: storeId, dates, expressDates, rateDates, rows, written, skippedRows: skipped, pickers, express };
}

/**
 * Which market does the Express Pickup dashboard need for this store?
 *
 * Its filters cascade WM week → market → store, and the Overview sheet is
 * empty until all three are set. The market cannot be read off the store
 * (underlying data is permission-denied), so it comes from the analyst's own
 * Settings › Defaults for their home store, or from shared/marketRoster.js
 * for any store listed there. Null means "don't try".
 */
async function resolveMarket(storeId) {
  const home = await getUserHomeStore().catch(() => null);
  if (home && String(home) === String(storeId)) {
    const m = await getUserHomeMarket().catch(() => null);
    if (m) return String(m);
  }
  const listed = listKnownMarkets().find((m) =>
    (getMarketRoster(m) || []).some((s) => String(s) === String(storeId)));
  return listed ? String(listed) : null;
}

/**
 * Which day-level dates do we already hold for a store, per source?
 *
 * Week documents store rows, not a date index, so this reads the week docs
 * that cover the lookback window and collects their distinct Pick Dates
 * (metrics), Express map keys (express), Express pick-rate keys (expressRate)
 * and the stored Express order count per day (expressOrders, which tells a
 * quiet Express day from an unread one).
 */
async function storedCoverage(storeId) {
  const weekKeys = await store.listWeeks(storeId).catch(() => []);
  const recent = weekKeys.sort().slice(-3);
  const metrics = new Set();
  const express = new Set();
  const expressRate = new Set();
  const expressOrders = {};
  for (const wk of recent) {
    const doc = await weeks.get(storeId, wk).catch(() => null);
    for (const row of doc?.rawData || []) {
      const raw = row["Pick Date"];
      if (!raw) continue;
      const [m, d, y] = String(raw).split("/").map((n) => parseInt(n, 10));
      if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) continue;
      const yyyy = y < 100 ? 2000 + y : y;
      metrics.add(`${yyyy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    for (const [k, v] of Object.entries(doc?.express || {})) { express.add(k); expressOrders[k] = v?.orders; }
    for (const k of Object.keys(doc?.expressRate || {})) expressRate.add(k);
  }
  return { metrics: [...metrics], express: [...express], expressRate: [...expressRate], expressOrders };
}

/**
 * Which stores should a pull cover?
 *
 * The user's OWN store, derived from the cached Auror identity
 * (shared/userStore.js). Only when that cannot be derived does the shared
 * `metrics/stores` list stand in, and only as a last resort.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ `metrics/stores` is ONE document shared by every install — every     │
 * │ analyst signs in anonymously to the same database. It used to be the │
 * │ primary answer here, which meant that as soon as two stores were in  │
 * │ it, EVERY install pulled for BOTH, and the schedule pull (which      │
 * │ scrapes whatever store the analyst's own scheduler shows) wrote that  │
 * │ analyst's roster under the list's first store. Store 5151's roster   │
 * │ landed in stores/1458/schedules/* on 2026-09-06 that way.            │
 * │                                                                      │
 * │ So: the shared list is a picker suggestion, not a pull target.       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Returns [] rather than inventing a default; the caller reports that as a
 * setup problem instead of silently pulling nothing.
 */
/**
 * A store number is at most 5 digits. Anything longer is an internal id that
 * leaked out of a scrape (the scheduler's locationId is 116580 for store
 * 1458).
 */
const isStoreNumber = (v) => /^\d{1,5}$/.test(String(v ?? ""));

async function resolveStores(explicit) {
  // Filter BEFORE any caller takes [0]. `saveStores` sorts as strings, so a
  // stray 6-digit id sorts AHEAD of a 4-digit store ("116580" < "1458") and
  // becomes the default for everything downstream — which is precisely how a
  // schedule ended up written under stores/116580/.
  if (explicit?.length) return explicit.map(String).filter(isStoreNumber);
  const home = await getUserHomeStore().catch(() => null);
  if (home && isStoreNumber(home)) return [String(home)];
  return [];
}

/**
 * The whole automated run.
 *
 * The SCHEDULE GOES FIRST, deliberately. It identifies its own store from the
 * portal page, so on a first run — empty database, no home store derivable —
 * it is the only source that can tell us which store we are. Its answer then
 * seeds the metrics pull, and the store list, in the same run.
 */
// ┌──────────────────────────────────────────────────────────────────────┐
// │ Return a BARE object — never one with an `ok` key.                   │
// │                                                                      │
// │ The dispatcher (background/service_worker.js) passes a result через  │
// │ untouched when it contains "ok", and wraps it as { ok: true, data }  │
// │ otherwise. shared/messaging.js::send() then REJECTS whenever         │
// │ resp.ok is falsy, using resp.error — which a partial result does not │
// │ have, because its failures live in an `errors` ARRAY.                │
// │                                                                      │
// │ Returning { ok: false, errors: [...] } therefore threw away the very │
// │ per-source detail this function exists to collect, and surfaced as   │
// │ a bare "digitalmetrics.pull_now failed". A partial pull is a normal  │
// │ outcome, not a transport failure.                                    │
// └──────────────────────────────────────────────────────────────────────┘
async function runPull({ force = false, stores = null } = {}) {
  const state = await getPullState();
  if (state.running) return { notRun: "a pull is already running" };
  if (!force && !isPullDue(new Date(), state.lastRunAt, { minGapMs: MIN_PULL_GAP_MS })) {
    return { notRun: "pulled too recently", lastRunAt: state.lastRunAt };
  }

  await setPullState({ running: true, runningSince: Date.now(), progress: null });

  // One Tableau capture at a time across the suite (shared/tableau_lock.js).
  // VizPick's open-check fires at the same moment a Sync-now click does, and
  // its four tabs starve this pull's 120s viz wait. Queue instead, and say so.
  return withTableauLock("Digital Metrics sync", () => runPullLocked({ force, stores }), {
    onWait: ({ heldBy }) => setProgress("waiting", { text: `waiting for ${heldBy} to finish with Tableau` }),
  });
}

async function runPullLocked({ force, stores }) {
  // The clock for "is this run dead" starts now, not when we joined the queue.
  await setPullState({ runningSince: Date.now(), progress: null });
  const result = { startedAt: new Date().toISOString(), metrics: [], schedule: null, errors: [] };

  // The sources report phases; without this the pill says "syncing…" for
  // the whole run and a slow sync is indistinguishable from a dead one.
  const SCHEDULE_PHASES = {
    opening:   "opening the scheduler",
    rendering: "waiting for the scheduler to render",
    reading:   "reading the schedule",
    nextWeek:  "reading next week's schedule",
  };
  const METRICS_PHASES = {
    opening:   (e) => e.source === "express"
      ? `opening Express Pickup for store ${e.store} (${e.date})`
      : e.source === "express-rate"
      ? `opening Express pick rate for store ${e.store} (${e.dates} day${e.dates === 1 ? "" : "s"})`
      : `opening Tableau for store ${e.store} (${e.dates} day${e.dates === 1 ? "" : "s"})`,
    rendering: (e) => e.source === "express"
      ? `waiting for the Express Pickup viz (${e.date})`
      : `waiting for the Tableau viz (store ${e.store})`,
    reading:   (e) => e.source === "express"
      ? `reading Express Pickup for ${e.date}`
      : `reading metrics for store ${e.store}`,
    done:      (e) => `store ${e.store}: ${e.rows} rows`,
  };

  try {
    const preResolved = await resolveStores(stores);

    // The schedule pull scrapes whatever store the analyst's OWN scheduler
    // page shows, so the only store it may be written under is that
    // analyst's home store. Never `preResolved[0]`: an explicit or shared
    // list can name someone else's store, and pullSchedule() now refuses to
    // write when the page disagrees with the expected store rather than
    // relabelling the roster.
    const home = await getUserHomeStore().catch(() => null);
    const scheduleStore = home && isStoreNumber(home) ? String(home) : null;

    // ── schedule ────────────────────────────────────────────────────────
    let discovered = null;
    // Every scheduled shift, kept so job titles can drive classification once
    // the metrics have said who actually picked.
    let scheduledAssociates = [];
    try {
      if (!scheduleStore) throw new Error("Choose a home store before syncing schedules.");
      await setProgress("schedule", { text: SCHEDULE_PHASES.opening });
      const sched = await pullSchedule({
        store: scheduleStore,
        onProgress: (e) => setProgress("schedule", { text: SCHEDULE_PHASES[e.phase] || e.phase }),
      });
      await setProgress("schedule", { text: "saving the schedule" });
      const written = [];
      for (const [date, doc] of Object.entries(sched.schedules)) {
        await schedules.put(sched.store, date, {
          ...doc, store: sched.store, importedAt: new Date().toISOString(),
        });
        written.push(date);
      }
      scheduledAssociates = Object.values(sched.schedules || {})
        .flatMap((d) => d.associates || []);
      discovered = sched.store ? String(sched.store) : null;
      result.schedule = {
        store: sched.store, weekStart: sched.weekStart, dates: written,
        shifts: sched.associateCount, clamped: sched.clampedCount, warnings: sched.warnings,
      };
    } catch (e) {
      result.errors.push({ scope: "schedule", error: String(e?.message ?? e) });
    }

    // ── metrics ─────────────────────────────────────────────────────────
    const list = [...new Set([...preResolved, ...(discovered ? [discovered] : [])])]
      .filter(isStoreNumber);
    result.stores = list;

    if (!list.length) {
      result.errors.push({
        scope: "metrics",
        error: "no store to pull. Nothing is stored yet, your home store could " +
               "not be derived, and the schedule pull did not identify one. " +
               "Set a store and retry.",
      });
    }

    for (const s of list) {
      const onProgress = (e) => setProgress("metrics", { text: (METRICS_PHASES[e.phase] || (() => e.phase))(e), store: s });
      try {
        const m = await pullMetricsForStore(s, { force, onProgress });
        result.metrics.push(m);
        // One error per store, not one per day — the view toasts each entry.
        const failed = m.express?.failed || [];
        if (failed.length) {
          result.errors.push({
            scope: `express ${s}`,
            error: failed.length === 1 && failed[0].date === "*"
              ? failed[0].error
              : `${failed.length} day${failed.length === 1 ? "" : "s"} failed: ` +
                failed.map((f) => `${f.date} (${f.error})`).join("; "),
          });
        }
      } catch (e) { result.errors.push({ scope: `metrics ${s}`, error: String(e?.message ?? e) }); }
    }

    // ── classification, derived from the scheduler's job titles ─────────
    //
    // Replaces the Classify tab as the primary input. Runs last because it
    // needs BOTH halves: job titles from the schedule, and who actually
    // picked from the metrics.
    if (scheduledAssociates.length) {
      try {
        await setProgress("classify", { text: "classifying from job titles" });
        const pickers = result.metrics.flatMap((m) => m.pickers || []);
        // The scheduled associates came from the schedule pull, so they
        // belong to the store that pull identified.
        const clsStore = discovered || scheduleStore;
        if (!clsStore) throw new Error("no store to classify for");
        const existing = await classifications.get(clsStore);
        const derived = deriveClassifications(scheduledAssociates, { existing, pickers });
        if (derived.changes.length) await classifications.put(clsStore, derived.map);
        result.classified = {
          changed: derived.changes.length,
          fromJobTitles: derived.derivedFrom,
          keptManual: derived.skippedManual,
          stillUnclassified: derived.unresolved.length,
        };
      } catch (e) {
        result.errors.push({ scope: "classify", error: String(e?.message ?? e) });
      }
    }

    // ── clock-ins (Global Time & Attendance), home store only ───────────
    //
    // Last, because it reads the grids the schedule feeds. Only the home
    // store: the timesheet lookup is scoped to the signed-in user's store.
    // A few seconds; a signed-out timesheet is recorded, not fatal.
    if (scheduleStore) {
      await setProgress("clockins", { text: "reading clock-ins from the timesheet" });
      const c = await autoClockIns(scheduleStore);
      result.clockIns = c;
      if (c.error) result.errors.push({ scope: "clock-ins", error: c.error });
    }

    // A store we only learned about this run must reach the store list, or the
    // picker stays empty and the next run rediscovers it from scratch.
    if (list.length) {
      const known = await store.listStores().catch(() => []);
      // Also drop anything already-stored that is not store-shaped, so a bad
      // id written by an earlier run gets cleaned up rather than persisting.
      const clean = known.filter(isStoreNumber);
      const added = list.filter((s) => !clean.includes(s));
      const dropped = known.filter((s) => !isStoreNumber(s));
      if (added.length || dropped.length) await store.saveStores([...clean, ...added]);
      result.newStores = added;
      if (dropped.length) result.droppedStores = dropped;
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    await setPullState({ running: false, runningSince: 0, progress: null, lastRunAt: Date.now(), lastResult: result });
    chrome.runtime.sendMessage({ module: "digitalmetrics", type: "pull-progress", progress: null }).catch(() => {});
  }

  return result;
}

/**
 * Alarm entry point. Exported so module.js can register the listener at
 * top-level script execution — an MV3 service worker that registers a listener
 * inside a handler will never be woken by it (MODULE_CONTRACT §4).
 */
/**
 * Install the hourly pull alarm.
 *
 * Uses ensureAlarm rather than chrome.alarms.create: create() RESETS the
 * schedule every time it runs, and an MV3 worker boots constantly, so a bare
 * create() at top level keeps pushing the next fire out by delayInMinutes and
 * the hourly cadence never settles. ensureAlarm only writes when the alarm is
 * missing or its period has drifted from the code.
 */
export async function installPullAlarm() {
  return ensureAlarm(PULL_ALARM, {
    periodInMinutes: PULL_PERIOD_MIN,
    // A freshly installed alarm should do something soon rather than after a
    // full hour, but not during boot itself.
    delayInMinutes: 5,
  });
}

export async function onPullAlarm() {
  if (!(await pullEnabled())) return;
  await runPull().catch(() => {});
}

// ── Daily Board live sync ─────────────────────────────────────────────────
//
// The store's hand-kept "Daily Board" workbook on OneDrive → today's (and,
// once updated, tomorrow's) assignment documents. Rules and rationale live in
// lib/data/board_sync.js; this is orchestration and device-local state.
//
// STORE 1458 ONLY (the user, 2026-09-23). The workbook is 1458's, so the sync
// refuses to run for anyone whose home store is not 1458 and only ever writes
// under stores/1458 — a second store's install never touches it.
//
// Cheap (two HTTP requests, no tab), so it runs on its own 30-minute alarm
// rather than behind the tab-opening auto-pull opt-in. Pasting the link is the
// opt-in: with no link saved the alarm does nothing.

export const BOARD_STORE = "1458";
export const BOARD_ALARM = "digitalmetrics.board";
const BOARD_PERIOD_MIN = 30;
const BOARD_LINK_KEY  = "digitalmetrics.boardLink";
const BOARD_SNAP_KEY  = "digitalmetrics.boardSnapshots";   // { date: { fp, cells, appliedAt } } — PII, local only
const BOARD_ALIAS_KEY = "digitalmetrics.boardAliases";     // { "KJ": "KIRA JUNE" } — PII, local only
const BOARD_STATE_KEY = "digitalmetrics.boardState";
const AUTO_EXC_KEY    = "digitalmetrics.autoExceptions";   // names deriveExceptions labelled

const CLOCK_KEY       = "digitalmetrics.clockIns";         // { store: { iso: { NAME: { clockIn, clockOut, mealOut, mealIn } } } } — PII, local only
const GTA_IDS_KEY     = "digitalmetrics.gtaIds";           // { NAME: { empId, win, gtaName } } — PII, local only
const CLOCK_KEEP_DAYS = 60;
const CLOCK_STATE_KEY = "digitalmetrics.clockPullState";
/** The automatic pull re-reads this many days back (incl. today): catches punch edits. */
const CLOCK_AUTO_DAYS = 7;

/**
 * Pull clock-ins for `names` over [from, to], merge them into local storage,
 * and record the outcome for the view. Never throws — the error is the result.
 * Measured 2026-09-23: ~0.1 s per surname lookup (first time only; matches are
 * cached), ~0.15 s per person for a day or a whole week, ~1 s to open a tab.
 */
async function syncClockIns(storeId, from, to, names, { auto }) {
  const t0 = Date.now();
  const people = [...new Set(names || [])].map((name) => ({ name }));
  let outcome;
  if (!people.length) {
    outcome = { matched: 0, unmatched: [], errors: [], days: 0 };
  } else {
    try {
      const idCache = await localGet(GTA_IDS_KEY, {});
      const res = await pullClockIns({ people, from, to, idCache });
      await chrome.storage.local.set({ [GTA_IDS_KEY]: res.ids });

      const all = await localGet(CLOCK_KEY, {});
      const mine = (all[String(storeId)] ||= {});
      let days = 0;
      for (const [name, rec] of Object.entries(res.byName)) {
        for (const [date, d] of Object.entries(rec.days)) {
          if (date < from || date > to) continue;
          // The meal window (MEAL switch → the punch after it) rides along:
          // the Insights shortfall view uses it to keep lunches that land on
          // assigned pick hours out of the blame buckets, and to flag meals
          // over 70 minutes. Minutes since midnight, like clockIn/clockOut.
          const mi = (d.punches || []).findIndex((p) => p.code === "MEAL");
          const toMin = (at) => {
            const m = /^(\d{2}):(\d{2})$/.exec(at || "");
            return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
          };
          (mine[date] ||= {})[name] = {
            clockIn: d.clockIn, clockOut: d.clockOut,
            mealOut: mi >= 0 ? toMin(d.punches[mi].at) : null,
            mealIn:  mi >= 0 && d.punches[mi + 1] ? toMin(d.punches[mi + 1].at) : null,
          };
          days++;
        }
      }
      const cutoff = new Date(Date.now() - CLOCK_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      for (const date of Object.keys(mine)) if (date < cutoff) delete mine[date];
      await chrome.storage.local.set({ [CLOCK_KEY]: all });
      outcome = { matched: Object.keys(res.byName).length, unmatched: res.unmatched, errors: res.errors, days };
    } catch (e) {
      outcome = { error: String(e?.message ?? e) };
    }
  }
  const state = { ...outcome, auto, store: String(storeId), from, to,
                  at: new Date().toISOString(), ms: Date.now() - t0 };
  await chrome.storage.local.set({ [CLOCK_STATE_KEY]: state });
  return state;
}

/** The hourly pull's clock-in step: the home store's last CLOCK_AUTO_DAYS of grids. */
async function autoClockIns(storeId) {
  const today = new Date();
  const dates = [];
  for (let i = CLOCK_AUTO_DAYS - 1; i >= 0; i--) {
    dates.push(isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  }
  const byDate = {};
  for (const date of dates) {
    const doc = await assignments.get(storeId, date).catch(() => null);
    if (doc) byDate[date] = doc;
  }
  // The whole digital roster, not just first-hour pick candidates: the
  // Insights shortfall view needs presence for everyone the board or the
  // schedule expected, because TLs erase call-ins from the board live and
  // only the schedule-vs-punches diff can see them. Coaches/TLs are skipped —
  // salaried, they never punch, and they are overseers, not task capacity.
  const names = new Set(clockInCandidates(byDate));
  for (const date of dates) {
    for (const row of byDate[date]?.associates || []) if (row.name) names.add(row.name);
    const sched = await schedules.get(storeId, date).catch(() => null);
    for (const a of sched?.associates || []) {
      if (a.name && isDigitalJob(a.jobName) && !leadershipForJob(a.jobName)) names.add(a.name);
    }
  }
  if (!names.size) return { skipped: "no one on the board or schedule to pull" };
  return syncClockIns(storeId, dates[0], dates.at(-1), [...names], { auto: true });
}

let boardRun = null;   // one sync at a time within a worker

export async function installBoardAlarm() {
  return ensureAlarm(BOARD_ALARM, { periodInMinutes: BOARD_PERIOD_MIN, delayInMinutes: 2 });
}

export async function onBoardAlarm() {
  await syncDailyBoard().catch(() => {});
}

async function localGet(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] ?? fallback;
}

/**
 * Pull the board and apply it. Never throws: the outcome, including any
 * error, is saved to BOARD_STATE_KEY for the view and returned.
 */
export function syncDailyBoard() {
  boardRun ||= runBoardSync().finally(() => { boardRun = null; });
  return boardRun;
}

async function runBoardSync() {
  const result = { at: new Date().toISOString(), store: BOARD_STORE, dates: [], error: null };
  try {
    const home = await getUserHomeStore().catch(() => null);
    if (String(home || "") !== BOARD_STORE) {
      result.notRun = `the Daily Board sync is for store ${BOARD_STORE} only`;
      return result;
    }
    const link = await localGet(BOARD_LINK_KEY, null);
    if (!link?.site || !link?.uniqueId) { result.notRun = "no Daily Board link saved"; return result; }

    await ensureAliases();
    const board = await fetchDailyBoard(link);
    result.file = { name: board.name, modifiedAt: board.modifiedAt };

    const sheets = weekdaySheets(board.sheets);
    const snaps  = await localGet(BOARD_SNAP_KEY, {});
    const aliases = await localGet(BOARD_ALIAS_KEY, {});
    const cls = (await classifications.get(BOARD_STORE)) || {};
    const isDigital = (n) => ["Digital", "Exceptions"].includes(cls[String(n).toUpperCase()]);
    const roster = Object.keys(cls).filter(isDigital);

    const today = localIsoDate();
    const scheduleCache = {};
    const scheduleFor = async (d) =>
      (scheduleCache[d] ??= (await schedules.get(BOARD_STORE, d).catch(() => null))?.associates || []);

    // Tomorrow's weekday sheet is last week's plan until it is overwritten
    // late the night before (the user, 2026-09-23). With no copy of our own to
    // compare against, decide by which day's schedule the names and hours
    // fit; unclear → last week's, so tomorrow stays blank rather than wrong.
    const sixAgo = addDays(today, -6), tomorrow = addDays(today, 1);
    const shared = sheets[new Date(`${tomorrow}T12:00:00Z`).getUTCDay()];
    let ambiguous = sixAgo;
    if (shared && !snaps[sixAgo] && !snaps[tomorrow]) {
      const opts = { aliases, isDigital, roster };
      const fitPast = scheduleFit(shared, await scheduleFor(sixAgo), opts);
      const fitNext = scheduleFit(shared, await scheduleFor(tomorrow), opts);
      if (fitNext > fitPast + 0.15) ambiguous = tomorrow;
      result.sharedSheetFit = { [sixAgo]: fitPast, [tomorrow]: fitNext };
    }

    // Board names learned across the week the workbook holds: the one person
    // whose hours fit a recurring name on (nearly) every day (board_sync.js
    // learnFromHistory). Each day uses our own copy where we have one.
    const week = [];
    for (let k = 0; k <= 6; k++) {
      const date = addDays(today, -k);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const cells = snaps[date]?.cells ||
        (k === 6 && ambiguous !== sixAgo ? null : sheets[weekday]);
      if (cells) week.push({ cells, schedule: await scheduleFor(date) });
    }
    const learned = learnFromHistory(week, { aliases, isDigital, roster });
    result.learned = Object.fromEntries(Object.entries(learned).map(([k, l]) => [k, l.name]));

    for (const plan of planDates(sheets, today, (d) => snaps[d] || null, () => ambiguous)) {
      if (plan.skip) { result.dates.push({ date: plan.date, skipped: plan.skip }); continue; }

      const doc = await assignments.get(BOARD_STORE, plan.date);
      if (doc?.finalized === true) {
        result.dates.push({ date: plan.date, skipped: "the day was finalized in the app" });
        continue;
      }
      // A past day the grid already treats as done (mostly filled, locked at
      // midnight) is history; the board only fills days left mostly empty.
      if (plan.mode === "backfill" && doc && isFinalized(doc)) {
        snaps[plan.date] = { fp: plan.fp, cells: plan.cells, names: {}, appliedAt: result.at, skipped: true };
        result.dates.push({ date: plan.date, skipped: "that day was already filled in the app and is locked" });
        continue;
      }
      const schedule = await scheduleFor(plan.date);
      const { matched, unmatched } = resolveBoardNames(plan.cells, schedule, { aliases, isDigital, roster, learned });
      const merged = mergeBoard(doc, {
        cells: plan.cells, matched,
        previous: snaps[plan.date]?.cells || null,
        previousNames: snaps[plan.date]?.names || null,
        // A past day's own edits were made after that day's plan, so the
        // board only fills its gaps.
        boardModifiedAt: plan.mode === "backfill" ? "0000" : board.modifiedAt,
        schedule,
      });

      if (!merged.unchanged) {
        await assignments.put(BOARD_STORE, plan.date, {
          associates:  merged.associates,
          date:        plan.date,
          day:         dayName(plan.date),
          store:       BOARD_STORE,
          updatedAt:   new Date().toISOString(),
          finalized:   false,
          finalizedAt: null,
        });
      }
      snaps[plan.date] = {
        fp: plan.fp, cells: plan.cells, appliedAt: result.at,
        names: Object.fromEntries(Object.keys(plan.cells).map((k) => [k, matched[k]?.name || k])),
        // Rows tied to a person by hours alone, not yet confirmed. They are not
        // evidence about that person (deriveExceptions below).
        guessed: Object.keys(plan.cells).filter((k) => String(matched[k]?.how || "").startsWith("hours")),
      };
      result.dates.push({
        date: plan.date,
        mode: plan.mode,
        rows: Object.keys(plan.cells).length,
        matched: Object.entries(matched).map(([boardName, m]) => ({ boardName, name: m.name, how: m.how, alt: m.alt })),
        unmatched,
        changedCells: merged.changedCells, addedRows: merged.addedRows, renamedRows: merged.renamedRows,
        noSchedule: !schedule.length,
      });
    }

    // Name fixes reach days already filled. A past day is locked against new
    // PLAN changes, but "KJ" turning out to be a particular person is not a
    // plan change: re-resolve each recent filled day with today's fixes and
    // move only the board's own cells to whoever the name now resolves to.
    const touched = new Set(result.dates.filter((d) => !d.skipped).map((d) => d.date));
    for (const [date, snap] of Object.entries(snaps)) {
      if (touched.has(date) || snap.skipped || !snap.names || date < addDays(today, -6) || date > today) continue;
      const schedule = await scheduleFor(date);
      const { matched, unmatched } = resolveBoardNames(snap.cells, schedule, { aliases, isDigital, roster, learned });
      // Keep the day's name status on screen: without this a filled day only
      // reports "already filled" and its ? / ~ flags vanish after one sync.
      const entry = result.dates.find((d) => d.date === date);
      const status = {
        date, mode: "filled", rows: Object.keys(snap.cells).length, unmatched,
        matched: Object.entries(matched).map(([boardName, m]) => ({ boardName, name: m.name, how: m.how, alt: m.alt })),
        changedCells: 0, addedRows: 0, renamedRows: 0, noSchedule: !schedule.length,
      };
      if (entry) Object.assign(entry, status, { skipped: undefined }); else result.dates.push(status);
      const names = Object.fromEntries(Object.keys(snap.cells).map((k) => [k, matched[k]?.name || k]));
      snap.guessed = Object.keys(snap.cells).filter((k) => String(matched[k]?.how || "").startsWith("hours"));
      if (Object.keys(names).every((k) => names[k] === snap.names[k])) continue;
      const doc = await assignments.get(BOARD_STORE, date);
      if (!doc || doc.finalized === true) continue;
      const merged = mergeBoard(doc, {
        cells: snap.cells, matched, previous: snap.cells, previousNames: snap.names, schedule,
      });
      if (!merged.unchanged) {
        await assignments.put(BOARD_STORE, date, {
          ...doc, associates: merged.associates, updatedAt: new Date().toISOString(),
        });
      }
      snap.names = names;
      result.renamed = [...(result.renamed || []), { date, moved: merged.renamedRows }];
    }

    // Exceptions, from a week of evidence (job_classify.js deriveExceptions):
    // the board's EXC vs PICK hours per resolved name, and the metrics'
    // exception share. Only ever touches Digital <-> Exceptions, and only
    // moves back the people this rule labelled (AUTO_EXC_KEY).
    try {
      const from = addDays(today, -6);
      const board = {};
      for (const [date, snap] of Object.entries(snaps)) {
        if (date < from || date > today || snap.skipped) continue;
        for (const [key, slots] of Object.entries(snap.cells || {})) {
          if (snap.guessed?.includes(key)) continue;   // unconfirmed ~ match
          const name = snap.names?.[key] || key;
          const b = (board[name] ||= { exc: 0, pick: 0 });
          for (const t of Object.values(slots)) {
            if (/^EXC/i.test(t)) b.exc++;
            else if (/^PICK$/i.test(t)) b.pick++;
          }
        }
      }
      const items = {};
      const weekKeys = [...new Set([weekKey(from), weekKey(today)])];
      for (const wk of weekKeys) {
        const doc = await weeks.get(BOARD_STORE, wk).catch(() => null);
        let last = null;
        for (const row of doc?.rawData || []) {
          const date = row["Pick Date"] ? dateKey(row["Pick Date"]) : last;
          if (row["Pick Date"]) last = date;
          if (!row.Associate || !date || date < from || date > today) continue;
          const n = (v) => Number(v) || 0;
          const i = (items[row.Associate] ||= { exc: 0, all: 0 });
          const exc = n(row["Exception Qty Req to Pick"]);
          i.exc += exc;
          i.all += exc + n(row["Picked As Req Qty"]) + n(row["Nil Pick Qty"]) + n(row["Substitution Qty"]);
        }
      }
      const auto = await localGet(AUTO_EXC_KEY, []);
      const current = (await classifications.get(BOARD_STORE)) || {};
      const { add, remove, evidence } = deriveExceptions({ board, items, current, auto });
      if (add.length || remove.length) {
        const next = { ...current };
        for (const n of add) next[n] = "Exceptions";
        for (const n of remove) next[n] = "Digital";
        await classifications.put(BOARD_STORE, next);
      }
      const nowAuto = [...new Set([...auto.filter((n) => !remove.includes(n)), ...add])]
        .filter((n) => (add.includes(n) || current[n] === "Exceptions"));
      await chrome.storage.local.set({ [AUTO_EXC_KEY]: nowAuto });
      result.exceptions = { added: add, removed: remove, flagged: nowAuto, evidence };
    } catch (e) {
      result.exceptionsError = String(e?.message ?? e);
    }

    // Only D-7 is ever compared against, so older snapshots are dead weight.
    const cutoff = addDays(today, -SNAPSHOT_KEEP_DAYS);
    for (const d of Object.keys(snaps)) if (d < cutoff) delete snaps[d];
    await chrome.storage.local.set({ [BOARD_SNAP_KEY]: snaps });
  } catch (e) {
    result.error = String(e?.message ?? e);
  } finally {
    await chrome.storage.local.set({ [BOARD_STATE_KEY]: result });
    chrome.runtime.sendMessage({ module: "digitalmetrics", type: "board-synced", result }).catch(() => {});
  }
  return result;
}

// The alias table is PII and lives only on this device. Rehydrate it into the
// names module on every SW wake, since the SW loses memory state after ~30s.
async function ensureAliases() {
  const got = await chrome.storage.local.get(ALIAS_KEY);
  loadAliases(got[ALIAS_KEY] || {});
}

const withAliases = (fn) => async (msg, sender) => {
  await ensureAliases();
  return fn(msg, sender);
};

export const handlers = {
  "get_classification_editor": withAliases((m) => classifications.editor(m.store)),
  "list_stores":       withAliases(()      => store.listStores()),
  "list_weeks":        withAliases((m)     => store.listWeeks(m.store)),
  "list_dates":        withAliases((m)     => store.listDates(m.store, m.collection)),

  "get_week":          withAliases((m)     => weeks.get(m.store, m.weekKey)),
  "put_week":          withAliases((m)     => weeks.put(m.store, m.weekKey, m.doc)),

  "get_classifications": withAliases((m)   => classifications.get(m.store)),
  "put_classifications": withAliases((m)   => classifications.put(m.store, m.map)),

  "get_schedule":      withAliases((m)     => schedules.get(m.store, m.date)),
  "put_schedule":      withAliases((m)     => schedules.put(m.store, m.date, m.doc)),

  // The store the ASSIGNMENTS tab is pinned to. Derived from the signed-in
  // identity (shared/userStore.js reads the cached Auror JWT and takes the
  // store out of the WIN suffix), never from the dashboard picker: a daily
  // plan is written per store and there is no reason for one person to be
  // editing another store's day.
  //
  // Returns null rather than throwing when it cannot be derived — the caller
  // falls back to the selected store, because locking someone out of their own
  // roster is worse than the thing the lock prevents.
  "get_home_store":    withAliases(async () => ({
    store: await getUserHomeStore().catch(() => null),
  })),

  "get_assignments":   withAliases((m)     => assignments.get(m.store, m.date)),
  "recent_assignments": withAliases((m)    => assignments.recent(m.store, m.limit ?? 30)),
  "put_assignments":   withAliases((m)     => assignments.put(m.store, m.date, m.doc)),

  "get_suggestions":   withAliases((m)     => suggestions.get(m.store, m.date)),
  "put_suggestions":   withAliases((m)     => suggestions.put(m.store, m.date, m.doc)),

  // ── Imports ─────────────────────────────────────────────────────────────
  //
  // The workbook is parsed in the VIEW, not here, and only the parsed records
  // cross the message boundary. chrome.runtime messages are JSON-serialised, so
  // sending raw file bytes would inflate a multi-megabyte export roughly
  // fourfold as an array of numbers. The parsers are pure ESM and import
  // cleanly into the page.

  /**
   * Persist an "Associate By Day" import.
   *
   * One upload routinely spans several stores AND several weeks, so it is
   * written as one document per (store, week) — never assumed to be a single
   * week for the currently-selected store.
   */
  "import_metrics": withAliases(async (m) => {
    const { groups, skipped } = splitByStoreWeek(m.records || [], { fileName: m.fileName });
    if (!groups.length) return { ok: false, error: "no rows with a usable store and date" };

    const written = [];
    for (const g of groups) {
      await weeks.put(g.store, g.weekKey, g.doc);
      written.push({ store: g.store, weekKey: g.weekKey, rows: g.doc.rawData.length });
    }

    // Keep the store list in step, or a newly-imported store never appears.
    const known = new Set(await store.listStores());
    const added = [...new Set(written.map((w) => w.store))].filter((s) => !known.has(s));
    if (added.length) await store.saveStores([...known, ...added]);

    return { written, skippedRows: skipped, newStores: added };
  }),

  /** Persist Daily Board days — one assignment document each. */
  "import_daily_board": withAliases(async (m) => {
    const written = [];
    for (const day of m.days || []) {
      await assignments.put(m.store, day.date, {
        associates: day.associates,
        date:       day.date,
        day:        dayName(day.date),
        store:      m.store,
        updatedAt:  new Date().toISOString(),
      });
      written.push({ date: day.date, associates: day.associates.length });
    }
    return { written };
  }),

  /** Persist scraped schedules — one document per date. */
  "import_schedules": withAliases(async (m) => {
    const written = [];
    for (const [date, doc] of Object.entries(m.schedules || {})) {
      await schedules.put(m.store, date, {
        ...doc, store: m.store, importedAt: new Date().toISOString(),
      });
      written.push(date);
    }
    return { written };
  }),

  // ── Automated pulls ─────────────────────────────────────────────────────
  //
  // The view drives these directly as well as the alarm, so a person can force
  // a refresh without waiting an hour and without flipping the schedule on.

  /** Run everything now, ignoring the minimum-gap guard. */
  "pull_now": withAliases((m) => runPull({ force: true, stores: m.stores || null })),

  /** One store's metrics, for the "Refresh this store" button. */
  "pull_store": withAliases(async (m) => {
    // Throw rather than returning an `ok` shape — the dispatcher turns a throw
    // into { ok:false, error } with the real message, which is what the view
    // can actually display. See the note above runPull.
    if (!m.store) throw new Error("no store given");
    return pullMetricsForStore(m.store, { force: !!m.force });
  }),

  // ── Daily Board (store 1458 only — see BOARD_STORE) ──────────────────────

  "board_sync_now":   withAliases(() => syncDailyBoard()),
  "board_status":     async () => ({
    state:   await localGet(BOARD_STATE_KEY, null),
    link:    await localGet(BOARD_LINK_KEY, null),
    aliases: await localGet(BOARD_ALIAS_KEY, {}),
    store:   BOARD_STORE,
  }),
  /** Save the share link (the opt-in). An empty link turns the sync off. */
  "board_set_link":   async (m) => {
    if (!m.link) { await chrome.storage.local.remove(BOARD_LINK_KEY); return { link: null }; }
    const link = parseShareLink(m.link);
    if (!link) throw new Error("that is not a OneDrive/SharePoint share link to a workbook");
    await chrome.storage.local.set({ [BOARD_LINK_KEY]: link });
    return { link };
  },
  /** Pin a typed board name to a full name ("KJ" → "KIRA JUNE"); empty clears it. */
  "board_set_alias":  async (m) => {
    const key = String(m.boardName || "").trim().replace(/\s+/g, " ").toUpperCase();
    if (!key) throw new Error("no board name given");
    const aliases = await localGet(BOARD_ALIAS_KEY, {});
    if (m.name) aliases[key] = String(m.name).trim().toUpperCase(); else delete aliases[key];
    await chrome.storage.local.set({ [BOARD_ALIAS_KEY]: aliases });
    return { aliases };
  },

  // ── Clock-ins (Global Time & Attendance) ──────────────────────────────
  //
  // Punch times are PII and stay in this browser: never written to Firestore.
  // Only clock-in/out minutes are kept (the page also carries each punch's
  // device location — dropped in gta_parse), for CLOCK_KEEP_DAYS.

  "get_clockins": async (m) => {
    const all = await localGet(CLOCK_KEY, {});
    return all[String(m.store)] || {};
  },
  /** The last clock-in pull, manual or automatic: { at, auto, matched, days, unmatched, errors, error, ms }. */
  "get_clock_state": async () => localGet(CLOCK_STATE_KEY, null),
  /** { store, from, to, people:[name] } → pull, merge, and report what matched. */
  "pull_clockins": withAliases((m) => syncClockIns(m.store, m.from, m.to, m.people, { auto: false })),

  /**
   * { from, to, people:[name] } → the raw GTA result, full punch lists
   * included (meal switches and all). Nothing is stored: this exists for
   * ad-hoc day audits, where "back from lunch at 2:48" matters and the
   * clockIn/clockOut summary that syncClockIns keeps is not enough.
   */
  "pull_punches": withAliases(async (m) => {
    const idCache = await localGet(GTA_IDS_KEY, {});
    const res = await pullClockIns({
      people: (m.people || []).map((name) => ({ name })),
      from: m.from, to: m.to, idCache,
    });
    await chrome.storage.local.set({ [GTA_IDS_KEY]: res.ids });
    return { byName: res.byName, unmatched: res.unmatched, errors: res.errors };
  }),

  /** The schedule only — it is the cheaper and more fragile of the two. */
  "pull_schedule_now": withAliases(async () => {
    const sched = await pullSchedule();
    const written = [];
    for (const [date, doc] of Object.entries(sched.schedules)) {
      await schedules.put(sched.store, date, {
        ...doc, store: sched.store, importedAt: new Date().toISOString(),
      });
      written.push(date);
    }
    return {
      store: sched.store, weekStart: sched.weekStart, written,
      shifts: sched.associateCount, clamped: sched.clampedCount, warnings: sched.warnings,
    };
  }),

  /**
   * Add a store to the list by hand.
   *
   * The escape hatch for the bootstrap problem: `metrics/stores` starts empty,
   * and both automatic routes (home store from the Auror JWT, store from the
   * scheduler page) can be unavailable — no AurorBuddy sign-in yet, portal
   * behind SSO. Without this the module has no way in at all.
   */
  "add_store": withAliases(async (m) => {
    const s = String(m.store ?? "").trim();
    if (!/^\d{1,5}$/.test(s)) throw new Error("store must be 1–5 digits");
    const bare = String(parseInt(s, 10));      // no leading zeros, matching Tableau
    const known = new Set(await store.listStores().catch(() => []));
    known.add(bare);
    await store.saveStores([...known]);
    return { store: bare, list: [...known].sort() };
  }),

  /** What the module would pull for if asked right now, and where it came from. */
  "get_default_store": async () => {
    const known = (await store.listStores().catch(() => [])).filter(isStoreNumber);
    // Home store first — the shared list belongs to every install, so its
    // first entry is whoever's store sorts lowest, not this analyst's.
    const home = await getUserHomeStore().catch(() => null);
    if (home && isStoreNumber(home)) return { store: String(home), source: "home", list: known };
    return { store: null, source: "none", list: [] };
  },

  "get_pull_state": async () => ({
    ...(await getPullState()),
    enabled: await pullEnabled(),
    minGapMs: MIN_PULL_GAP_MS,
    staleMs: PULL_STALE_MS,
  }),

  "set_pull_enabled": async (m) => {
    await chrome.storage.sync.set({ [PULL_ENABLED_KEY]: !!m.enabled });
    return { enabled: !!m.enabled };
  },

  // ── Alias table (local-only PII, never synced, never written to Firestore)
  "get_aliases": async () => {
    const got = await chrome.storage.local.get(ALIAS_KEY);
    return got[ALIAS_KEY] || {};
  },
  "put_aliases": async (m) => {
    await chrome.storage.local.set({ [ALIAS_KEY]: m.aliases || {} });
    loadAliases(m.aliases || {});
    return { count: aliasCount() };
  },
};
