// modules/sparkscango/lib/capture_common.js
//
// Factory used by content/powerbi_ssg_capture.js — parameterizes a MAIN-
// world fetch/XHR patch with a URL matcher + list of body markers so one
// content script can capture QES bundles for all four Spark & Scan&Go
// source pages.
//
// This module is imported by the content script (via inlining — MV3
// content scripts can't ES-import). Kept as its own file for testability
// and clarity; the content script contains an equivalent inlined version.

/**
 * @typedef {object} CaptureConfig
 * @property {string} sentinelKey    window[<key>] guard so double-install is a no-op
 * @property {RegExp} urlMatcher     which requests to capture (QES endpoint)
 * @property {Record<string, RegExp>} bodyMarkers
 *                                   pageKey → regex matched against request body
 * @property {number} [ringMax]      default 20
 */

/**
 * Build the capture object exposed on window. Pure factory — the actual
 * fetch/XHR patching happens inside the content script's IIFE.
 */
export function makeCaptureRegistry(config) {
  const ring = [];
  const {
    urlMatcher,
    bodyMarkers,
    ringMax = 20,
  } = config;

  function pageKeyForRequest(reqBody) {
    if (typeof reqBody !== "string") return null;
    for (const [key, re] of Object.entries(bodyMarkers)) {
      if (re.test(reqBody)) return key;
    }
    return null;
  }

  function record(entry) {
    entry.capturedAt = Date.now();
    ring.push(entry);
    if (ring.length > ringMax) ring.shift();
  }

  function shouldCapture(url, method) {
    return method === "POST" && urlMatcher.test(url || "");
  }

  function findLatest(pageKey) {
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      if (!r.reqBody || !r.respBody) continue;
      if (r.status !== 200 && r.status !== 0) continue;
      if (pageKey && r.pageKey !== pageKey) continue;
      return r;
    }
    return null;
  }

  return {
    ring,
    shouldCapture,
    pageKeyForRequest,
    record,
    findLatest,
    all:    () => ring.slice(),
    latest: () => (ring.length ? ring[ring.length - 1] : null),
    clear:  () => { ring.length = 0; },
  };
}
