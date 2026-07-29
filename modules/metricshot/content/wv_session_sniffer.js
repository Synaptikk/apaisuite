// modules/metricshot/content/wv_session_sniffer.js
//
// MAIN-world content script. Runs on every workvivo.walmart.com tab at
// document_start. The Sendbird JS SDK on this page is NEVER exposed on
// `window` (confirmed 2026-07-28 via CDP: no global, no iframe, v2.chat=false),
// so we can't drive it directly. But the SDK talks to the Sendbird Platform
// REST/WS API using a rotating `Session-key` header, and that key is stored
// AES-encrypted in IndexedDB — unreadable.
//
// So instead we SNIFF the key straight off the SDK's own outbound requests.
// The SDK fires authenticated calls (channel-list, changelogs, presence)
// within ~1s of load and continuously after, so by the time MetricShot wants
// to post, a fresh key is sitting on window for the in-page REST helper to use.
//
// We stash the latest creds on a window global that the extension reads via
// chrome.scripting.executeScript (MAIN world). Mirrors the fetch/XHR patch
// pattern from modules/sparkfraud/content/capture.js.
//
// Captured: Session-key, App-Id, and user_id (parsed from the request URL,
// e.g. /v3/users/{userId}/my_group_channels).

(() => {
  if (window.__APAISUITE_METRICSHOT_SBKEY_INSTALLED) return; // idempotent
  window.__APAISUITE_METRICSHOT_SBKEY_INSTALLED = true;

  // The shared credential slot the extension reads.
  // Shape: { sessionKey, appId, userId, ts } — null until first sniff.
  window.__APAISUITE_METRICSHOT_SBKEY = null;

  const USER_ID_RE = /\/v3\/users\/([^/?]+)/i;

  function stash(url, headers) {
    // headers: plain object with lowercased keys.
    const sessionKey = headers["session-key"];
    if (!sessionKey) return; // only care about authenticated SDK calls
    const appId = headers["app-id"] || null;
    let userId = null;
    try { const m = USER_ID_RE.exec(url || ""); if (m) userId = decodeURIComponent(m[1]); } catch (_) {}
    const prev = window.__APAISUITE_METRICSHOT_SBKEY;
    window.__APAISUITE_METRICSHOT_SBKEY = {
      sessionKey,
      appId: appId || (prev && prev.appId) || null,
      userId: userId || (prev && prev.userId) || null,
      ts: Date.now(),
    };
  }

  function onlySendbird(url) {
    return typeof url === "string" && /sendbird\.com\/v3\//i.test(url);
  }

  // ── fetch ─────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (onlySendbird(url)) {
        const headers = {};
        if (input && typeof input !== "string" && input.headers) {
          try { for (const [k, v] of input.headers.entries()) headers[k.toLowerCase()] = v; } catch (_) {}
        }
        if (init && init.headers) {
          const h = init.headers;
          try {
            if (h instanceof Headers) { for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v; }
            else if (Array.isArray(h)) { for (const [k, v] of h) headers[k.toLowerCase()] = v; }
            else { for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]; }
          } catch (_) {}
        }
        stash(url, headers);
      }
    } catch (_) { /* never break the page's fetch */ }
    return origFetch.apply(this, arguments);
  };

  // ── XMLHttpRequest ────────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSetHeader = XHR.prototype.setRequestHeader;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__mshotSniff = { url, headers: {} };
    return origOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    if (this.__mshotSniff) this.__mshotSniff.headers[String(name).toLowerCase()] = value;
    return origSetHeader.apply(this, arguments);
  };
  XHR.prototype.send = function () {
    try {
      if (this.__mshotSniff && onlySendbird(this.__mshotSniff.url)) {
        stash(this.__mshotSniff.url, this.__mshotSniff.headers);
      }
    } catch (_) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  console.log("[APAISuite/MetricShot] Sendbird session-key sniffer installed");
})();
