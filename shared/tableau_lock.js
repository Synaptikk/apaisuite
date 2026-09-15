// shared/tableau_lock.js
//
// One background Tableau capture at a time, suite-wide.
//
// THE PROBLEM
// -----------
// Several modules drive stores.tableau.wal-mart.com from hidden tabs: VizPick
// (a stores export plus a Today crawl across up to three lane tabs) and
// Digital Metrics (one view per store). Each fires on its own alarm AND when
// the suite is opened, so they routinely start within seconds of each other.
// Edge throttles background tabs to a shared budget, and Tableau's SSO chain
// and viz render are what every one of those tabs is waiting on — so four
// tabs racing take longer in total than the same four in turn, and the one
// with the tightest timeout (Digital Metrics: 120s for the viz) is the one
// that loses. Observed 2026-09-14: a Digital Metrics sync started alongside
// VizPick's open-check and sat behind four VizPick tabs.
//
// THE FIX
// -------
// A single in-worker mutex. Captures queue in arrival order; a waiter is told
// who it is waiting on so it can say so in its own progress UI rather than
// looking hung. In memory only, deliberately: every capture runs in the one
// service worker, and if that worker dies the captures die with it, so there
// is nothing stale to clean up on boot. A hold longer than MAX_HOLD_MS is
// treated as leaked and released, so a bug in one module cannot wedge the
// others.
//
// This serialises WHOLE captures, not tabs — VizPick's three lanes stay
// parallel inside its own turn. The measured 2.8× from those lanes is
// unaffected; what changes is that nobody else's tab shares the window.

// Longer than the longest capture we have (VizPick's Today crawl budgets 25
// minutes), so real work is never cut short.
export const MAX_HOLD_MS = 30 * 60_000;

// A waiter gives up queueing after this and runs anyway. Past it the holder
// is almost certainly wedged in a way MAX_HOLD_MS has not caught yet, and a
// capture that never starts is worse than one that shares the browser.
export const MAX_WAIT_MS = 10 * 60_000;

let holder = null;            // { label, since, done: Promise }
let releaseHolder = null;

function now() { return Date.now(); }

/** Who holds the lock right now, or null. For diagnostics and tests. */
export function tableauLockHolder() {
  if (!holder) return null;
  return { label: holder.label, heldMs: now() - holder.since };
}

/**
 * Run `fn` while holding the suite-wide Tableau capture lock.
 *
 * @param {string} label   Who is capturing — surfaced to whoever waits behind it.
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {(info: {heldBy: string, heldMs: number}) => void} [opts.onWait]
 *        Called once if the lock is busy, before waiting. Use it to show
 *        "waiting for X" in the caller's own progress UI.
 * @param {number} [opts.maxWaitMs]   Override MAX_WAIT_MS (tests).
 * @param {number} [opts.maxHoldMs]   Override MAX_HOLD_MS (tests).
 * @returns {Promise<T>}
 */
export async function withTableauLock(label, fn, { onWait, maxWaitMs = MAX_WAIT_MS, maxHoldMs = MAX_HOLD_MS } = {}) {
  const arrivedAt = now();
  let announced = false;

  while (holder) {
    // A holder past its budget has leaked (an error path that skipped
    // release, or an await that never settles). Evict it rather than queue
    // behind it forever.
    if (now() - holder.since > maxHoldMs) {
      console.warn(`[APAISuite tableau_lock] evicting "${holder.label}" after ${Math.round((now() - holder.since) / 60000)} min`);
      releaseHolder?.();
      break;
    }
    if (now() - arrivedAt > maxWaitMs) {
      console.warn(`[APAISuite tableau_lock] "${label}" waited ${Math.round(maxWaitMs / 60000)} min for "${holder.label}"; proceeding without the lock`);
      return fn();
    }
    if (!announced) {
      announced = true;
      try { onWait?.({ heldBy: holder.label, heldMs: now() - holder.since }); } catch { /* caller's problem */ }
    }
    // Wake when the current holder finishes (or is evicted), then re-check:
    // another waiter may have got in first, and that is the intended order.
    await Promise.race([holder.done, sleep(Math.max(1, Math.min(5_000, maxWaitMs)))]);
  }

  let settle;
  const done = new Promise((r) => { settle = r; });
  holder = { label, since: now(), done };
  releaseHolder = () => {
    if (holder?.done !== done) return;   // already released or evicted
    holder = null;
    releaseHolder = null;
    settle();
  };
  const release = releaseHolder;
  try {
    return await fn();
  } finally {
    release();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
