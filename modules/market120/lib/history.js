// modules/market120/lib/history.js
//
// Week-over-week history store for Market 120 store-level Clearance/Deleted
// metrics. Persists one snapshot per ISO week per store in
// chrome.storage.local, then computes WoW deltas on read.
//
// Storage shape (single key, bounded):
//   market120.history.stores = {
//     weeks: {
//       "2026-W31": { capturedAt, stores: { "658": {units,dollars}, ... } },
//       "2026-W30": { ... },
//       ...
//     }
//   }
//
// We keep at most MAX_WEEKS most-recent weeks so the key never grows without
// bound (chrome.storage.local per-item soft limits). Only two headline
// metrics per store (Total C/D $ + Units) per the approved scope.

const KEY = "market120.history.stores";
const MAX_WEEKS = 26; // ~6 months of weekly snapshots

// ── ISO week key ─────────────────────────────────────────────────────
// Returns e.g. "2026-W31". ISO-8601: week 1 is the week containing the
// first Thursday; weeks start Monday.
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;          // Sun=0 → 7
  d.setUTCDate(d.getUTCDate() + 4 - day);  // shift to Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function load() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] || { weeks: {} };
}

async function save(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

/**
 * Record a weekly snapshot. Rows are the per-store objects from
 * parseStoresCsv (only store/totalUnits/totalDollars are used here).
 * Idempotent within a week: re-running in the same ISO week overwrites that
 * week's snapshot rather than duplicating it (a refresh should update "this
 * week", not create phantom history).
 *
 * @param {Array<{store:string,totalUnits:number,totalDollars:number}>} rows
 * @param {Date} [now]
 * @returns {Promise<{weekKey:string, storeCount:number}>}
 */
export async function recordSnapshot(rows, now = new Date()) {
  const state = await load();
  const weekKey = isoWeekKey(now);

  const stores = {};
  for (const r of rows) {
    stores[r.store] = {
      units:   Number(r.totalUnits) || 0,
      dollars: Number(r.totalDollars) || 0,
    };
  }

  state.weeks[weekKey] = { capturedAt: now.toISOString(), stores };

  // Prune to the most-recent MAX_WEEKS by sorted week key.
  const keys = Object.keys(state.weeks).sort(); // lexical sort works for YYYY-Www
  while (keys.length > MAX_WEEKS) {
    delete state.weeks[keys.shift()];
  }

  await save(state);
  return { weekKey, storeCount: rows.length };
}

/**
 * Compute week-over-week rows for the two most-recent weeks on record.
 * When only one week exists, deltas are null (baseline week — honest, no
 * fabricated change).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   currentWeek: string|null,
 *   priorWeek: string|null,
 *   capturedAt: string|null,
 *   rows: Array<{
 *     store:string,
 *     units:number, dollars:number,
 *     prevUnits:number|null, prevDollars:number|null,
 *     dUnits:number|null, dDollars:number|null,
 *     pctUnits:number|null, pctDollars:number|null,
 *     isNew:boolean
 *   }>,
 *   weekCount:number
 * }>}
 */
export async function computeWoW() {
  const state = await load();
  const weekKeys = Object.keys(state.weeks).sort(); // ascending
  if (!weekKeys.length) {
    return { ok: true, currentWeek: null, priorWeek: null, capturedAt: null, rows: [], weekCount: 0 };
  }

  const curKey = weekKeys[weekKeys.length - 1];
  const prevKey = weekKeys.length >= 2 ? weekKeys[weekKeys.length - 2] : null;
  const cur = state.weeks[curKey];
  const prev = prevKey ? state.weeks[prevKey] : null;

  const rows = Object.keys(cur.stores)
    .map((store) => {
      const c = cur.stores[store];
      const p = prev ? prev.stores[store] : null;
      const prevUnits = p ? p.units : null;
      const prevDollars = p ? p.dollars : null;
      const dUnits = p ? c.units - p.units : null;
      const dDollars = p ? c.dollars - p.dollars : null;
      return {
        store,
        units:   c.units,
        dollars: c.dollars,
        prevUnits,
        prevDollars,
        dUnits,
        dDollars,
        pctUnits:   pct(c.units, prevUnits),
        pctDollars: pct(c.dollars, prevDollars),
        isNew:      prev != null && p == null, // appeared this week only
      };
    })
    .sort((a, b) => b.dollars - a.dollars); // biggest exposure first

  return {
    ok: true,
    currentWeek: curKey,
    priorWeek: prevKey,
    capturedAt: cur.capturedAt,
    rows,
    weekCount: weekKeys.length,
  };
}

// Percent change guarded against divide-by-zero / missing prior.
function pct(current, prior) {
  if (prior == null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// For diagnostics / tests: how many weeks are on record.
export async function weekCount() {
  const state = await load();
  return Object.keys(state.weeks).length;
}

// Clear all history (Settings / testing only).
export async function clearHistory() {
  await chrome.storage.local.remove(KEY);
}
