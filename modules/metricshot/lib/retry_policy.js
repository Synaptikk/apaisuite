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

/** A "sending" entry older than this means the run died mid-flight. Longer
 *  than a full capture+post run (3 x (90 s capture + 120 s post)) so a live
 *  run is never resumed underneath itself. */
export const SENDING_STALE_MS = 15 * 60_000;

/**
 * May a failed post have delivered anyway? True when the outcome is unknown —
 * the watchdog fired, the script/tab died, the request threw, or the server
 * answered 5xx — so the caller must read the channel back before re-sending.
 * A definitive 4xx, auth/lookup failure, or a failure before the message
 * create (S3 signature/upload, no tab/session) means nothing was posted.
 */
export function postOutcomeUnknown(post) {
  if (!post || post.ok) return false;
  const cls = String(post.errorClass || "");
  if (cls === "POST_HUNG" || cls === "SCRIPT_FAIL") return true;
  if (cls === "REST_FAIL" || cls === "POST_FAIL") {
    const m = String(post.error || "").match(/(?:post|HTTP) (\d{3})/);
    if (!m) return true;                       // threw / no result
    const code = Number(m[1]);
    return !(code >= 400 && code < 500);
  }
  return false;
}

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
 * The postedRuns entry written BEFORE a send. Carries the prior failure count
 * (so failureEntry keeps counting) and any delivered report parts (so a
 * resumed report job does not email twice).
 */
export function sendingEntry(prior, at, claimId = null) {
  return {
    status: "sending",
    at,
    claimId,
    failures: (prior && prior.failures) || 0,
    ...(prior && prior.parts ? { parts: prior.parts } : {}),
    // A resume of a previous "sending" — the caller must read back first.
    resumed: !!(prior && prior.status === "sending"),
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

  // Another install at this store holds or delivered the shared claim
  // (shared/post_claims.js). Terminal: re-checking would only re-read it.
  if (prior.status === "skipped-claimed") return { run: false, reason: "claimed-elsewhere" };

  // Written BEFORE the send. Young → a run is (or was just) in flight; old →
  // the worker died mid-run, so resume — the caller reads the channel back
  // for the run's marker before sending again.
  if (prior.status === "sending") {
    if (now - (prior.at || 0) < SENDING_STALE_MS) return { run: false, reason: "in-flight" };
    if (prior.gaveUp || (prior.failures || 0) >= MAX_RUN_FAILURES) return { run: false, reason: "gave-up" };
    return { run: true, reason: "resume" };
  }

  // "ok", "skipped-stale", "skipped-store" are terminal — the slot is finished with.
  if (prior.status !== "failed") return { run: false, reason: "already-posted" };

  if (prior.gaveUp || (prior.failures || 0) >= MAX_RUN_FAILURES) {
    return { run: false, reason: "gave-up" };
  }
  if (now < (prior.nextRetryAt || 0)) return { run: false, reason: "backoff" };
  return { run: true, reason: "retry" };
}
