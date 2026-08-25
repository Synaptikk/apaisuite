// modules/digitalmetrics/lib/pull_schedule.js
//
// When should an automated pull run, and for which dates?
//
// Pure so it can be tested without a browser: everything here is a decision,
// and service.js performs it. The rule the whole thing exists to enforce is
// "don't re-pull what we already have, but do re-pull what might have changed".

/** Metrics land late; the current day is never complete. */
export const LOOKBACK_DAYS = 8;

/**
 * Dates that are always re-pulled even when already stored.
 *
 * Fulfilment metrics for a day keep settling after midnight — late scans,
 * corrections, exception reprocessing. Treating a stored day as final on the
 * day it happened bakes in a partial number permanently, which is exactly the
 * failure the donor's "skip dates that already exist" rule produced.
 */
export const VOLATILE_DAYS = 2;

const pad = (n) => String(n).padStart(2, "0");

/** Local-time YYYY-MM-DD. Never toISOString(), which shifts to UTC. */
export function isoDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function daysBack(from, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i);
    out.push(isoDay(d));
  }
  return out;
}

/**
 * Which dates need pulling for a store.
 *
 * @param now        Date — "today", injected so this is testable.
 * @param haveDates  iterable of YYYY-MM-DD already stored.
 */
export function datesToPull(now, haveDates = [], { lookback = LOOKBACK_DAYS, volatile: vol = VOLATILE_DAYS } = {}) {
  const have = new Set(haveDates);
  const candidates = daysBack(now, lookback);
  const alwaysRefresh = new Set(daysBack(now, vol));
  return candidates.filter((d) => !have.has(d) || alwaysRefresh.has(d));
}

/**
 * Is a pull due?
 *
 * `minGapMs` guards against the alarm firing repeatedly after a service-worker
 * restart storm — MV3 wakes the worker often, and a pull is expensive (a real
 * browser tab against a corporate report).
 */
export function isPullDue(now, lastRunAt, { minGapMs }) {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt >= minGapMs;
}
