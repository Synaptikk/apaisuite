// modules/metricshot/lib/retry_policy.js
//
// When may a scheduled run be (re)attempted?
//
// Extracted from service.js::tick because getting it wrong is invisible: the
// original rule was "don't record failures, let the next tick retry", which
// reads as reasonable and is fine at a slow poll. The tick is every MINUTE,
// and nothing counted attempts — so a permanently-failing run re-ran until
// the staleness window closed it out an hour later. Observed 2026-08-21:
// ~13 cycles x 3 attempts = ~39 captures across 65 minutes, each holding a
// Tableau tab for the full 90s watchdog.
//
// Pure — no chrome APIs, no clock of its own. `now` is always passed in.

/** Backoff between whole RUNS (a run is already retries+1 attempts inside).
 *  Indexed by failure count; the last value repeats. Sized so a transiently
 *  wedged tab still gets another shot inside the catch-up window, while a
 *  genuinely broken capture stops burning tab time quickly. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000];

/** Failed runs before giving up on this slot entirely. Without a ceiling the
 *  only brake was the staleness window. */
export const MAX_RUN_FAILURES = 3;

export function backoffFor(failures) {
  const i = Math.min(Math.max(failures, 1) - 1, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i];
}

/**
 * The postedRuns entry to persist after a run has exhausted its attempts.
 *
 * @param {object|undefined} prior  Existing entry for this runKey, if any.
 * @param {number} at               Now, ms.
 * @param {{stage?:string, error?:string}} status
 */
export function failureEntry(prior, at, status = {}) {
  const failures = ((prior && prior.failures) || 0) + 1;
  return {
    status: "failed",
    at,
    failures,
    // Recorded even on the final failure: the give-up decision should be
    // legible in storage, not implied by a missing field.
    nextRetryAt: at + backoffFor(failures),
    gaveUp: failures >= MAX_RUN_FAILURES,
    stage: status.stage ?? null,
    error: status.error ?? null,
  };
}

/**
 * May this run fire now?
 *
 * @param {object|undefined} prior  postedRuns[runKey]
 * @param {number} now
 * @returns {{run:boolean, reason:string}}
 */
export function runDecision(prior, now) {
  if (!prior) return { run: true, reason: "never-run" };

  // "ok" and "skipped-stale" are both terminal — the slot is finished with.
  if (prior.status !== "failed") return { run: false, reason: "already-posted" };

  if (prior.gaveUp || (prior.failures || 0) >= MAX_RUN_FAILURES) {
    return { run: false, reason: "gave-up" };
  }
  if (now < (prior.nextRetryAt || 0)) return { run: false, reason: "backoff" };
  return { run: true, reason: "retry" };
}
