// modules/metricshot/lib/cdp.js
//
// Shared chrome.debugger (CDP) plumbing for the metricshot module. Extracted
// from capture.js so both the screenshot capture and the Workvivo UI upload
// (workvivo_upload.js) reuse ONE attach/detach + timeout implementation
// instead of copy-pasting it (DRY).
//
// chrome.debugger.sendCommand has NO built-in timeout — against a wedged /
// zombie tab, commands can hang forever and a trailing .catch() never fires
// because the await never settles. Every command here is wrapped so a stuck
// call rejects fast and the caller can surface an error / retry.

export const CDP_VERSION = "1.3";
const TAG = "[metricshot cdp]";

// Tabs where we currently have CDP attached, tracked so overlapping calls to
// the same tab don't collide with "another debugger is already attached".
const _attached = new Set();
// Guard `chrome` for non-extension contexts (unit tests import this module).
const _chrome = typeof chrome !== "undefined" ? chrome : undefined;
_chrome?.tabs?.onRemoved?.addListener?.((tabId) => _attached.delete(tabId));
_chrome?.debugger?.onDetach?.addListener?.((source) => {
  if (source?.tabId != null) _attached.delete(source.tabId);
});

/** Attach the debugger to a tab. Returns true on success (or if already
 *  attached), false if attach failed (e.g. DevTools is open). */
export async function attach(tabId) {
  if (_attached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    _attached.add(tabId);
    return true;
  } catch (e) {
    console.warn(TAG, "attach failed:", e?.message ?? e);
    return false;
  }
}

/** Detach the debugger from a tab. Never throws. */
export async function detach(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* already gone */ }
  _attached.delete(tabId);
}

export function isAttached(tabId) { return _attached.has(tabId); }

/** Send a CDP command with a hard timeout so a stuck call can't hang forever. */
export function sendCdp(tabId, method, params, timeoutMs = 15_000) {
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    timeoutMs,
    `CDP ${method}`,
  );
}

/** Race a promise against a timeout. Rejects with a labelled Error on timeout. */
export function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label || "operation"} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Wait for network activity on a tab to go idle. Requires `Network.enable` to
 * have been sent first. Listens to chrome.debugger.onEvent (which fires GLOBALLY
 * for every attached target, so we filter by source.tabId).
 *
 * Resolves true once, after `minWaitMs` has elapsed, there have been zero
 * in-flight requests for a sustained `idleMs` window. Resolves false on timeout.
 * Also records completed responses so callers can inspect what actually posted.
 *
 * @param {number} tabId
 * @param {object} [opts]
 * @param {number} [opts.idleMs=2000]     quiet window that counts as "idle"
 * @param {number} [opts.minWaitMs=3000]  never return before this (lets the
 *                                        upload request actually start)
 * @param {number} [opts.timeoutMs=30000]
 * @param {(resp:{url:string,status:number,method:string})=>void} [opts.onResponse]
 * @returns {Promise<{idle:boolean, responses:Array, completed:number}>}
 */
export async function waitForNetworkIdle(tabId, opts = {}) {
  const { idleMs = 2000, minWaitMs = 3000, timeoutMs = 30_000, onResponse } = opts;
  const _c = typeof chrome !== "undefined" ? chrome : undefined;
  if (!_c?.debugger?.onEvent) return { idle: false, responses: [], completed: 0 };

  let inFlight = 0;
  let completed = 0;
  let lastActivity = Date.now();
  const start = Date.now();
  const responses = [];
  const reqMeta = new Map(); // requestId → {url, method}

  const listener = (source, method, params) => {
    if (source?.tabId !== tabId) return;
    if (method === "Network.requestWillBeSent") {
      inFlight++;
      lastActivity = Date.now();
      reqMeta.set(params.requestId, { url: params.request?.url, method: params.request?.method });
    } else if (method === "Network.responseReceived") {
      const meta = reqMeta.get(params.requestId) || {};
      const resp = { url: params.response?.url || meta.url, status: params.response?.status, method: meta.method };
      responses.push(resp);
      try { onResponse?.(resp); } catch { /* ignore */ }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      inFlight = Math.max(0, inFlight - 1);
      completed++;
      lastActivity = Date.now();
    }
  };

  _c.debugger.onEvent.addListener(listener);
  try {
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
      const idleFor = Date.now() - lastActivity;
      if (Date.now() - start >= minWaitMs && inFlight <= 0 && idleFor >= idleMs) {
        return { idle: true, responses, completed };
      }
    }
    return { idle: false, responses, completed };
  } finally {
    _c.debugger.onEvent.removeListener(listener);
  }
}
