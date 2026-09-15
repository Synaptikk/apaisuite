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
import { dayName } from "./lib/data/grid.js";
import { pivotAssociateData } from "./lib/data/tableau.js";
import { pullMetrics } from "./lib/sources/tableau_metrics.js";
import { pullExpressDay } from "./lib/sources/tableau_express.js";
import { mergeWeekDoc } from "./lib/data/express.js";
import { weekKey } from "./lib/data/weeks.js";
import { pullSchedule } from "./lib/sources/wfm_schedule.js";
import { datesToPull, isPullDue, isoDay } from "./lib/pull_schedule.js";
import { getUserHomeStore, getUserHomeMarket } from "../../shared/userStore.js";
import { getMarketRoster, listKnownMarkets } from "../../shared/marketRoster.js";
import { ensureAlarm } from "../../shared/alarms.js";
import { withTableauLock } from "../../shared/tableau_lock.js";
import { deriveClassifications } from "./lib/data/job_classify.js";

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
    ? { metrics: [], express: [] }
    : await storedCoverage(storeId).catch(() => ({ metrics: [], express: [] }));
  const dates        = datesToPull(now, have.metrics);
  const expressDates = datesToPull(now, have.express);
  if (!dates.length && !expressDates.length) return { store: storeId, skipped: "up to date" };

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
          express.pulled++;
        } catch (e) {
          express.failed.push({ date: d, error: String(e?.message ?? e) });
        }
      }
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
    });
  }

  // A newly-seen store must reach the store list or it never appears in the UI.
  const knownStores = new Set(await store.listStores());
  const added = [...new Set(written.map((w) => w.store))].filter((s) => !knownStores.has(s));
  if (added.length) await store.saveStores([...knownStores, ...added]);

  return { store: storeId, dates, expressDates, rows, written, skippedRows: skipped, pickers, express };
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
 * (metrics) and Express map keys (express).
 */
async function storedCoverage(storeId) {
  const weekKeys = await store.listWeeks(storeId).catch(() => []);
  const recent = weekKeys.sort().slice(-3);
  const metrics = new Set();
  const express = new Set();
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
    for (const k of Object.keys(doc?.express || {})) express.add(k);
  }
  return { metrics: [...metrics], express: [...express] };
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
  };
  const METRICS_PHASES = {
    opening:   (e) => e.source === "express"
      ? `opening Express Pickup for store ${e.store} (${e.date})`
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
