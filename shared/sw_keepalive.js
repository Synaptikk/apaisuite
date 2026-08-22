// shared/sw_keepalive.js
//
// Keeps the MV3 service worker alive for the duration of a long job.
//
// THE PROBLEM
// -----------
// An extension service worker is torn down after ~30 seconds of inactivity.
// "Activity" means *calling an extension API* — not awaiting a promise, and
// not a fetch() in flight. Two things normally hold it up during a job started
// from the suite page:
//
//   1. the open sendResponse channel back to the shell page, and
//   2. whatever chrome.* calls the job happens to make.
//
// Reason 1 evaporates the moment the user closes the suite tab or navigates it
// elsewhere: the port closes and that keep-alive is gone. Reason 2 is pure
// luck — vizpick's Today crawl polls chrome.tabs and chrome.scripting every few
// hundred ms so it survives, while a job that is mostly `await fetch(...)` to a
// remote host makes no API calls at all and gets killed at the 30s mark, part
// way through, with no error anywhere.
//
// That is why a background load "stops when you navigate away" — it is not
// cancelled, the worker running it is simply collected.
//
// THE FIX
// -------
// Ping a trivial extension API on an interval while a job is in flight. Each
// call resets the idle timer. Refcounted, so overlapping jobs share one timer
// and the last one out turns it off.
//
// This is a documented-behaviour workaround, not a hack around a restriction:
// the platform's rule is "alive while doing extension work", and a running
// capture *is* extension work — it simply has no obligation to touch an API
// while it waits on the network.

const PING_MS = 20_000;      // comfortably inside the ~30s idle window

// A leaked handle must not pin the worker forever. Longer than the longest job
// we have (vizpick's Today crawl budgets 25 minutes) so it never cuts real
// work short, short enough that a bug costs a browser session, not a battery.
const MAX_HOLD_MS = 35 * 60_000;

let holders = 0;
let timer = null;
let startedAt = 0;
const labels = new Set();

function ping() {
  try {
    // Cheapest real API call available in a worker. The RESULT is irrelevant;
    // making the call is the entire point.
    chrome.runtime.getPlatformInfo?.(() => void chrome.runtime.lastError);
  } catch { /* API gone — the worker is going away regardless */ }
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  holders = 0;
  labels.clear();
}

/**
 * Hold the worker awake until the returned function is called.
 *
 * ALWAYS release in a `finally`. A handle leaked on an error path keeps the
 * worker up until MAX_HOLD_MS, which is a battery cost, not a correctness one —
 * but it also masks the leak.
 *
 *   const release = keepAwake("vizpick.pullToday");
 *   try { ...long job... } finally { release(); }
 *
 * @param {string} label  For diagnostics only.
 * @returns {() => void}  Idempotent release.
 */
export function keepAwake(label = "job") {
  // Extension pages do not need this and have no idle timeout; calling it
  // there should be harmless rather than an error, so callers can share code
  // between contexts.
  if (typeof chrome === "undefined" || !chrome.runtime?.getPlatformInfo) {
    return () => {};
  }

  holders++;
  labels.add(label);
  if (!timer) {
    startedAt = Date.now();
    timer = setInterval(() => {
      if (Date.now() - startedAt > MAX_HOLD_MS) {
        console.warn(`[sw-keepalive] held ${Math.round(MAX_HOLD_MS / 60_000)}min by [${[...labels].join(", ")}] — releasing; a handle was probably leaked`);
        stopTimer();
        return;
      }
      ping();
    }, PING_MS);
    // Fire once immediately: a job that finishes inside the first interval
    // still gets the timer reset it needed.
    ping();
  }

  let released = false;
  return function release() {
    if (released) return;      // idempotent — double-release must not
    released = true;           // decrement someone else's hold
    labels.delete(label);
    holders = Math.max(0, holders - 1);
    if (holders === 0) stopTimer();
  };
}

/** Wrap a promise-returning function so it holds the worker for its duration. */
export async function withKeepAwake(label, fn) {
  const release = keepAwake(label);
  try {
    return await fn();
  } finally {
    release();
  }
}

export const _internals = {
  PING_MS, MAX_HOLD_MS,
  state: () => ({ holders, running: !!timer, labels: [...labels] }),
};
