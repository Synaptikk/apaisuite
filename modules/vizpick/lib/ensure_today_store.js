// modules/vizpick/lib/ensure_today_store.js
//
// "Give me a current Today row for this one store, capturing it if you have
// to." The market rollup's own crawl is store-list-driven and stamps the whole
// snapshot; this is the single-store door into the same pipeline, for callers
// that need one store's numbers on their own schedule.
//
// WHY THIS EXISTS
// ---------------
// metricshot used to open its own Tableau tab, inject the store parameter and
// replay two crosstab exports — Location Details and Department Breakout — to
// build its Workvivo post. vizpick's Today crawl exports those same two sheets
// for every store in the market. Two tabs, two sessions, the same rows pulled
// twice, and the two copies free to disagree about what "now" meant.
//
// Now there is one copy. metricshot asks for the store it is posting about; if
// vizpick captured it recently enough, that costs a storage read and no tab at
// all. If not, one store is re-captured and written back — so vizpick's rollup
// gets the benefit of metricshot's schedule rather than the two racing.
//
// The write is deliberately row-scoped (snapshots.upsertTodayRow, not
// mergeToday): refreshing one store must not tell the rollup the whole market
// is current. See that function's note.

import * as snapshots from "./snapshots.js";
import { fetchVizpickTodayTableau } from "./sources/vizpick_today_tableau.js";

// Default staleness ceiling, matching MAX_TODAY_AGE_MS in the Today source:
// the current-day data republishes roughly every 2-3 h, so anything younger
// than this is the same numbers a re-capture would return.
export const DEFAULT_MAX_AGE_MS = 90 * 60_000;

/** Numeric compare — see the note on vizpick_today_tableau.js::sameStore. */
function sameStore(a, b) {
  if (a == null || b == null) return false;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

export function findRow(today, store) {
  return (today?.rows || []).find((r) => sameStore(r.store, store)) || null;
}

/**
 * Age of a specific row, in ms. Infinity when there is no usable stamp at all,
 * which reads as "stale" everywhere it is compared — the safe direction.
 */
export function rowAgeMs(row, today, now = Date.now()) {
  const at = snapshots.rowCapturedAt(row, today);
  if (!at) return Infinity;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? Math.max(0, now - t) : Infinity;
}

/**
 * @param {string|number} store
 * @param {object}  [opts]
 * @param {number}  [opts.maxAgeMs]   Older than this and the store is re-captured.
 * @param {boolean} [opts.allowCapture=true]  false = read-only; never opens a tab.
 * @returns {Promise<{
 *   row: object|null, capturedAt: string|null, sourceUpdate: object|null,
 *   refreshed: boolean, ageMs: number, reason: string,
 * }>}
 *   `row` is null only when there is nothing stored AND no capture happened or
 *   the capture failed. Callers should treat that as "use whatever you had".
 */
export async function ensureTodayRowForStore(store, opts = {}) {
  const {
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    allowCapture = true,
  } = opts;

  const wanted = String(store ?? "").trim();
  if (!wanted) {
    return { row: null, capturedAt: null, sourceUpdate: null, refreshed: false, ageMs: Infinity, reason: "no store" };
  }

  const snap = await snapshots.read();
  const today = snap?.today || null;
  const stored = findRow(today, wanted);
  const ageMs = rowAgeMs(stored, today);

  if (stored && ageMs <= maxAgeMs) {
    return {
      row: stored,
      capturedAt: snapshots.rowCapturedAt(stored, today),
      sourceUpdate: today?.sourceUpdate || null,
      refreshed: false, ageMs, reason: "fresh",
    };
  }

  if (!allowCapture) {
    return {
      row: stored,
      capturedAt: snapshots.rowCapturedAt(stored, today),
      sourceUpdate: today?.sourceUpdate || null,
      refreshed: false, ageMs,
      reason: stored ? "stale, capture not allowed" : "absent, capture not allowed",
    };
  }

  // force: the stamp check is a market-level optimisation and would report
  // "unchanged" for a store it has never visited. We have already decided this
  // row is too old; that is the decision.
  let result = null;
  try {
    result = await fetchVizpickTodayTableau([wanted], { force: true });
  } catch (e) {
    return {
      row: stored,
      capturedAt: snapshots.rowCapturedAt(stored, today),
      sourceUpdate: today?.sourceUpdate || null,
      refreshed: false, ageMs, reason: `capture threw: ${String(e?.message ?? e)}`,
    };
  }

  const fresh = (result?.rows || []).find((r) => sameStore(r.store, wanted)) || null;
  if (!fresh) {
    // Keep serving the stale row rather than nothing: an hours-old number with
    // an honest stamp beats a blank card.
    return {
      row: stored,
      capturedAt: snapshots.rowCapturedAt(stored, today),
      sourceUpdate: today?.sourceUpdate || null,
      refreshed: false, ageMs,
      reason: result?.error ? `capture failed: ${result.error}` : "capture returned no row",
    };
  }

  const capturedAt = result.capturedAt || new Date().toISOString();
  try {
    await snapshots.upsertTodayRow({
      row: fresh,
      capturedAt,
      sourceUpdate: result.sourceUpdate || null,
      market: fresh.market ?? null,
    });
  } catch { /* the row is still returned below; persistence is the bonus */ }

  return {
    row: fresh,
    capturedAt,
    sourceUpdate: result.sourceUpdate || today?.sourceUpdate || null,
    refreshed: true, ageMs, reason: "recaptured",
  };
}
