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
import { pullSchedule } from "./lib/sources/wfm_schedule.js";
import { datesToPull, isPullDue, isoDay } from "./lib/pull_schedule.js";
import { getUserHomeStore } from "../../shared/userStore.js";
import { ensureAlarm } from "../../shared/alarms.js";
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

async function getPullState() {
  const got = await chrome.storage.local.get(PULL_STATE_KEY);
  return got[PULL_STATE_KEY] || { lastRunAt: 0, lastResult: null, running: false };
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

/** One store's metrics pull: fetch → pivot → split → persist. */
async function pullMetricsForStore(storeId, { force = false } = {}) {
  // Week documents hold rows, not a date index, so "what do we already have"
  // means reading the recent weeks and collecting their distinct Pick Dates.
  const have = force ? [] : await storedDates(storeId).catch(() => []);
  const dates = datesToPull(new Date(), have);
  if (!dates.length) return { store: storeId, skipped: "up to date" };

  const pulled = await pullMetrics(storeId, dates);
  const wide = pivotAssociateData(pulled.rows);
  const { groups, skipped } = splitByStoreWeek(wide, { fileName: `auto-pull ${isoDay(new Date())}` });

  // Who actually picked. Feeds the Store Help half of the classification rule
  // (see lib/data/job_classify.js) — the roster is ~440 people and only ~150
  // of them appear here.
  const pickers = [...new Set(wide.map((r) => String(r.Associate || "").trim().toUpperCase()).filter(Boolean))];

  const written = [];
  for (const g of groups) {
    await weeks.put(g.store, g.weekKey, g.doc);
    written.push({ store: g.store, weekKey: g.weekKey, rows: g.doc.rawData.length });
  }

  // A newly-seen store must reach the store list or it never appears in the UI.
  const knownStores = new Set(await store.listStores());
  const added = [...new Set(written.map((w) => w.store))].filter((s) => !knownStores.has(s));
  if (added.length) await store.saveStores([...knownStores, ...added]);

  return { store: storeId, dates, rows: pulled.rows.length, written, skippedRows: skipped, pickers };
}

/**
 * Which day-level dates do we already hold for a store?
 *
 * Week documents store rows, not a date index, so this reads the week docs
 * that cover the lookback window and collects their distinct Pick Dates.
 */
async function storedDates(storeId) {
  const weekKeys = await store.listWeeks(storeId).catch(() => []);
  const recent = weekKeys.sort().slice(-3);
  const seen = new Set();
  for (const wk of recent) {
    const doc = await weeks.get(storeId, wk).catch(() => null);
    for (const row of doc?.rawData || []) {
      const raw = row["Pick Date"];
      if (!raw) continue;
      const [m, d, y] = String(raw).split("/").map((n) => parseInt(n, 10));
      if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) continue;
      const yyyy = y < 100 ? 2000 + y : y;
      seen.add(`${yyyy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  return [...seen];
}

/**
 * Which stores should a pull cover?
 *
 * `metrics/stores` is the normal answer, but it is EMPTY on a fresh database —
 * and it only ever gets filled by importing data, which the pull cannot do
 * without knowing a store. That circle has to be broken from outside, so fall
 * back to the user's own home store (shared/userStore.js derives it from the
 * Auror JWT's WIN suffix).
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
  const known = (await store.listStores().catch(() => [])).filter(isStoreNumber);
  if (known.length) return known;
  const home = await getUserHomeStore().catch(() => null);
  return home && isStoreNumber(home) ? [String(home)] : [];
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

  await setPullState({ running: true });
  const result = { startedAt: new Date().toISOString(), metrics: [], schedule: null, errors: [] };

  try {
    // Resolve up front so the schedule pull knows which store it is FOR. It
    // can still self-identify when we have nothing (first run), but a scraped
    // id must never override a known one — `locations[0].locationId` is an
    // internal id (116580 for store 1458) and writing under it is silent
    // corruption.
    const preResolved = await resolveStores(stores);

    // ── schedule ────────────────────────────────────────────────────────
    let discovered = null;
    // Every scheduled shift, kept so job titles can drive classification once
    // the metrics have said who actually picked.
    let scheduledAssociates = [];
    try {
      const sched = await pullSchedule({ store: preResolved[0] || null });
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
      try { result.metrics.push(await pullMetricsForStore(s, { force })); }
      catch (e) { result.errors.push({ scope: `metrics ${s}`, error: String(e?.message ?? e) }); }
    }

    // ── classification, derived from the scheduler's job titles ─────────
    //
    // Replaces the Classify tab as the primary input. Runs last because it
    // needs BOTH halves: job titles from the schedule, and who actually
    // picked from the metrics.
    if (scheduledAssociates.length) {
      try {
        const pickers = result.metrics.flatMap((m) => m.pickers || []);
        const existing = await classifications.get();
        const derived = deriveClassifications(scheduledAssociates, { existing, pickers });
        if (derived.changes.length) await classifications.put(derived.map);
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
    await setPullState({ running: false, lastRunAt: Date.now(), lastResult: result });
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
  "list_stores":       withAliases(()      => store.listStores()),
  "list_weeks":        withAliases((m)     => store.listWeeks(m.store)),
  "list_dates":        withAliases((m)     => store.listDates(m.store, m.collection)),

  "get_week":          withAliases((m)     => weeks.get(m.store, m.weekKey)),
  "put_week":          withAliases((m)     => weeks.put(m.store, m.weekKey, m.doc)),

  "get_classifications": withAliases(()    => classifications.get()),
  "put_classifications": withAliases((m)   => classifications.put(m.map)),

  "get_schedule":      withAliases((m)     => schedules.get(m.store, m.date)),
  "put_schedule":      withAliases((m)     => schedules.put(m.store, m.date, m.doc)),

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
    const known = await store.listStores().catch(() => []);
    if (known.length) return { store: known[0], source: "stored", list: known };
    const home = await getUserHomeStore().catch(() => null);
    if (home) return { store: String(home), source: "home", list: [] };
    return { store: null, source: "none", list: [] };
  },

  "get_pull_state": async () => ({
    ...(await getPullState()),
    enabled: await pullEnabled(),
    minGapMs: MIN_PULL_GAP_MS,
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
