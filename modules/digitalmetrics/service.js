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

const ALIAS_KEY = "digitalmetrics.aliases";

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
