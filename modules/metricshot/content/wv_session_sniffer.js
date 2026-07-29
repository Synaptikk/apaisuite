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

  // ── Recon log ─────────────────────────────────────────────────
  // Ring buffer of recent non-GET requests, so we can discover how the
  // Workvivo UI *actually* uploads images (the Sendbird session-key path
  // returns 400 "File-messages via SDK are disabled"). Populated for
  // sendbird.com AND workvivo.walmart.com POST/PUT/PATCH calls. Read via
  // window.__APAISUITE_METRICSHOT_NETLOG. Capped so it can't grow unbounded.
  const NETLOG_MAX = 60;
  window.__APAISUITE_METRICSHOT_NETLOG = [];
  function netlog(entry) {
    try {
      const log = window.__APAISUITE_METRICSHOT_NETLOG;
      log.push({ ...entry, ts: Date.now() });
      if (log.length > NETLOG_MAX) log.splice(0, log.length - NETLOG_MAX);
    } catch (_) { /* ignore */ }
  }
  function interesting(url, method) {
    if (typeof url !== "string") return false;
    if (!/sendbird\.com|workvivo\.walmart\.com/i.test(url)) return false;
    const m = String(method || "GET").toUpperCase();
    // File uploads are multipart POST/PUT; message sends are POST. Skip GETs.
    return m === "POST" || m === "PUT" || m === "PATCH";
  }
  function bodyKind(body) {
    if (!body) return null;
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const fields = [];
      try { for (const k of body.keys()) fields.push(k); } catch (_) {}
      return { type: "FormData", fields };
    }
    if (typeof body === "string") return { type: "string", len: body.length, sample: body.slice(0, 200) };
    if (typeof Blob !== "undefined" && body instanceof Blob) return { type: "Blob", size: body.size, mime: body.type };
    return { type: typeof body };
  }

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
      const method = (init && init.method) || (input && typeof input !== "string" && input.method) || "GET";
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
      if (interesting(url, method)) {
        netlog({ via: "fetch", method: String(method).toUpperCase(), url, body: bodyKind(init && init.body) });
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
    this.__mshotSniff = { url, method, headers: {} };
    return origOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    if (this.__mshotSniff) this.__mshotSniff.headers[String(name).toLowerCase()] = value;
    return origSetHeader.apply(this, arguments);
  };
  XHR.prototype.send = function (body) {
    try {
      if (this.__mshotSniff && onlySendbird(this.__mshotSniff.url)) {
        stash(this.__mshotSniff.url, this.__mshotSniff.headers);
      }
      if (this.__mshotSniff && interesting(this.__mshotSniff.url, this.__mshotSniff.method)) {
        netlog({ via: "xhr", method: String(this.__mshotSniff.method).toUpperCase(), url: this.__mshotSniff.url, body: bodyKind(body) });
      }
    } catch (_) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  console.log("[APAISuite/MetricShot] Sendbird session-key sniffer installed");
})();
