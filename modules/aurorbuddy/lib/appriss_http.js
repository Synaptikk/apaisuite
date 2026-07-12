// lib/appriss_http.js — low-level HTTP client for the APPRISS Secure API
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from appriss.js so business logic and HTTP machinery don't share
// the same file. All exports consumed by appriss.js; nothing here knows about
// suspects, stores, or name matching.

const _BASE = "https://wmtus.apprissretailcloud.com";

// Exported so appriss.js can reuse them in probeApprissApiAuth without
// duplicating the URL or headers object.
export const SEARCH_URL = `${_BASE}/platform/cpf/searchlite/getsearchresults`;
export const HEADERS = {
  "content-type":      "application/json;charset=UTF-8",
  "x-requested-with":  "XMLHttpRequest",
  "accept":            "application/json, text/plain, */*",
  "referer":           `${_BASE}/platform/explorer`
};

// ─── Retry / timeout constants ────────────────────────────────────────────

// Per-request fetch timeout. 90s: some async backend jobs for multi-card
// suspects were consistently hitting the old 60s wall. 90s matches the
// observed worst-case APPRISS backend latency.
const HTTP_TIMEOUT_MS        = 90_000;

const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_DEFAULT_MS  = 5000;  // fallback when Retry-After header absent

const SERVER_MAX_RETRIES     = 2;     // retry 5xx up to N times
const SERVER_RETRY_MS        = 3000;

// APPRISS sometimes returns { running: true } immediately — the async job
// hasn't finished yet. Retry a couple of times before accepting it.
const TRANSIENT_MAX_RETRIES  = 2;
const TRANSIENT_RETRY_MS     = 1000;

const POSTJSON_TAG = "[Secure]";

// ─── Congestion tracking ──────────────────────────────────────────────────
// Module-scoped sliding window of recent HTTP_TIMEOUT_MS aborts. The
// orchestrator (apprissLookupAll) polls getSecureCongestionState() after
// each completed lookup and emits a `congestion` UI event when the threshold
// trips. Window/threshold are tuned for the observed worst case (a Secure
// backend that's responding in 20-90s instead of <2s — several timeouts
// in close succession is the signal).
const _timeoutEvents = [];
const CONGESTION_WINDOW_MS = 30_000;
const CONGESTION_THRESHOLD = 3;

function _pruneTimeoutEvents(now = Date.now()) {
  while (_timeoutEvents.length && _timeoutEvents[0] < now - CONGESTION_WINDOW_MS) {
    _timeoutEvents.shift();
  }
}

export function getSecureCongestionState() {
  _pruneTimeoutEvents();
  return {
    timeouts:  _timeoutEvents.length,
    congested: _timeoutEvents.length >= CONGESTION_THRESHOLD,
    windowMs:  CONGESTION_WINDOW_MS,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function fail(reason, ctx = {}) {
  console.warn(`${POSTJSON_TAG} postJson fail: ${reason}`, ctx);
  return null;
}

// Merge any number of AbortSignals into one that aborts when the first fires.
// Prefers native AbortSignal.any (Chromium >= 116); falls back to a manual
// implementation so we don't crash on older builds.
function mergeAbortSignals(...signals) {
  const real = signals.filter(Boolean);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(real);
  const ctrl = new AbortController();
  const abort = () => { try { ctrl.abort(); } catch {} };
  for (const s of real) {
    if (s.aborted) { abort(); break; }
    s.addEventListener("abort", abort, { once: true });
  }
  return ctrl.signal;
}

function parseRetryAfter(headers, defaultMs) {
  const v = headers.get("retry-after");
  if (!v) return defaultMs;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : defaultMs;
}

function isTransientRunning(payload) {
  return payload?.running === true || payload?.data?.running === true;
}

// ─── postJson ─────────────────────────────────────────────────────────────
// Single entry point for all APPRISS API calls. Handles:
//   - per-request timeout (HTTP_TIMEOUT_MS) merged with outer scan-abort signal
//   - 429 rate-limit with Retry-After honour
//   - 5xx transient server errors with fixed back-off
//   - { running: true } async-job responses with retries
//   - HTML auth-wall detection (session expired / not authenticated)
//   - attaches __elapsed_ms to returned data for caller-side diagnostics

export async function postJson(body, { label = "call", signal: outerSignal } = {}) {
  let rateAttempts = 0, transientAttempts = 0, serverAttempts = 0;
  const t0 = Date.now();
  while (true) {
    // Check the scan-level abort before doing any more work — prevents
    // starting retries on stale scans.
    if (outerSignal?.aborted) return fail(`${label} cancelled before request`);
    let r;
    // Merge our per-request timeout with the outer scan-level abort signal so
    // whichever fires first cancels the fetch. The timer must be cleared
    // whether the fetch resolves OR throws — otherwise each aborted request
    // leaves a 90s dangling timer (harmless but noisy). finally{} handles both.
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const combined = mergeAbortSignals(timeoutCtrl.signal, outerSignal);
      r = await fetch(SEARCH_URL, {
        method: "POST",
        credentials: "include",
        headers: HEADERS,
        body: JSON.stringify(body),
        signal: combined
      });
    } catch (e) {
      // Network-level abort, timeout, DNS failure, TLS error, etc.
      // Inline name + message so the SW console shows it without expanding.
      const name = e?.name || "?";
      const msg  = String(e?.message ?? e);
      const timedOut = timeoutCtrl.signal.aborted && !outerSignal?.aborted;
      if (timedOut) _timeoutEvents.push(Date.now());
      return fail(`${label} fetch exception: ${name}: ${msg}`, {
        cancelled:     !!outerSignal?.aborted,
        timeoutAborted: timeoutCtrl.signal.aborted
      });
    } finally {
      clearTimeout(timer);
    }

    // 429 — rate limited: honour Retry-After header then retry
    if (r.status === 429) {
      if (rateAttempts >= RATE_LIMIT_MAX_RETRIES) {
        return fail(`${label} 429 after ${rateAttempts} retries`);
      }
      const retryAfter = parseRetryAfter(r.headers, RATE_LIMIT_DEFAULT_MS);
      rateAttempts++;
      console.log(`${POSTJSON_TAG} ${label} 429 — sleeping ${retryAfter}ms (${rateAttempts}/${RATE_LIMIT_MAX_RETRIES})`);
      await new Promise(res => setTimeout(res, retryAfter));
      continue;
    }

    // 5xx — transient server error: fixed back-off then retry
    if (r.status >= 500 && r.status < 600) {
      if (serverAttempts >= SERVER_MAX_RETRIES) {
        return fail(`${label} HTTP ${r.status} after ${serverAttempts} retries`);
      }
      serverAttempts++;
      console.log(`${POSTJSON_TAG} ${label} HTTP ${r.status} — sleeping ${SERVER_RETRY_MS}ms (${serverAttempts}/${SERVER_MAX_RETRIES})`);
      await new Promise(res => setTimeout(res, SERVER_RETRY_MS));
      continue;
    }

    if (!r.ok) {
      // Other non-2xx (401/403/404) — not transient; give up.
      let preview = "";
      try { preview = (await r.text()).slice(0, 160); } catch {}
      return fail(`${label} HTTP ${r.status}`, { preview });
    }

    // Read as text first so we can detect auth-wall HTML even when
    // JSON.parse throws — gives a far more actionable log message.
    let text;
    try { text = await r.text(); } catch { return fail(`${label} response read error`); }
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("json") && (text.trimStart().startsWith("<") || ct.includes("html"))) {
      console.warn(`${POSTJSON_TAG} ${label} — auth wall: got HTML instead of JSON. Session expired?`);
      return fail(`${label} auth wall (HTML response — session expired?)`, { url: r.url });
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch { return fail(`${label} JSON parse`, { preview: text.slice(0, 80) }); }
    if (!payload?.success) {
      return fail(`${label} success=false`, { keys: Object.keys(payload || {}).slice(0, 6) });
    }

    if (isTransientRunning(payload)) {
      if (transientAttempts >= TRANSIENT_MAX_RETRIES) {
        const data = payload.data ?? {};
        data.__elapsed_ms = Date.now() - t0;
        return data;
      }
      transientAttempts++;
      console.log(`${POSTJSON_TAG} ${label} running=true — sleeping ${TRANSIENT_RETRY_MS}ms (${transientAttempts}/${TRANSIENT_MAX_RETRIES})`);
      await new Promise(res => setTimeout(res, TRANSIENT_RETRY_MS));
      continue;
    }

    const data = payload.data ?? {};
    // Attach elapsed time so callers can detect 'returned suspiciously fast
    // with empty rows' — signals Secure hadn't computed yet.
    data.__elapsed_ms = Date.now() - t0;
    return data;
  }
}
