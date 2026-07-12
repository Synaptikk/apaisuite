// modules/sparkfraud/content/capture.js
//
// MAIN-world content script. Runs on every gscope tab at document_start.
// Monkey-patches window.fetch and XMLHttpRequest to record every outgoing
// request's URL + headers + body + response. Many gscope SPAs use axios
// which falls back to XHR — patching only fetch misses them.
//
// Migrated from donor extension/capture.js. Changes:
//   - Install guard renamed: window.__SPARK_CAP → window.__APAISUITE_SPARKFRAUD_CAP
//     (same install-guard collision rule that bit ClosingList; suite-prefixed
//     name lets the suite coexist cleanly with the standalone donor even
//     though MAIN-world content scripts can't easily detect "which extension
//     installed me first" otherwise).
//   - The capture buffer is read by service.js handlers via
//     chrome.scripting.executeScript that reads window.__APAISUITE_SPARKFRAUD_CAP.

(() => {
  if (window.__APAISUITE_SPARKFRAUD_CAP) return; // already installed

  const cap = [];
  window.__APAISUITE_SPARKFRAUD_CAP = cap;

  function record(entry) {
    cap.push(entry);
    if (cap.length > 200) cap.splice(0, cap.length - 200);
  }

  // ── fetch ─────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (input && input.method) || "GET";
    const headers = {};
    if (input && typeof input !== "string" && input.headers) {
      try { for (const [k, v] of input.headers.entries()) headers[k.toLowerCase()] = v; } catch (_) {}
    }
    if (init && init.headers) {
      const h = init.headers;
      try {
        if (h instanceof Headers) {
          for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k.toLowerCase()] = v;
        } else {
          for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
        }
      } catch (_) {}
    }
    const body = init && init.body ? String(init.body).slice(0, 5000) : null;
    const entry = { via: "fetch", url, method, headers, body, ts: Date.now() };
    record(entry);

    const resp = await origFetch.apply(this, arguments);
    // Clone so the page can still consume the body
    try {
      const clone = resp.clone();
      clone.text().then(t => { entry.responseText = t.slice(0, 10_000_000); entry.responseStatus = resp.status; }).catch(() => {});
    } catch (_) {}
    return resp;
  };

  // ── XMLHttpRequest ────────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSetHeader = XHR.prototype.setRequestHeader;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__sparkfraud = { method, url, headers: {} };
    return origOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    if (this.__sparkfraud) this.__sparkfraud.headers[name.toLowerCase()] = value;
    return origSetHeader.apply(this, arguments);
  };
  XHR.prototype.send = function (body) {
    if (this.__sparkfraud) {
      const entry = {
        via: "xhr",
        url: this.__sparkfraud.url,
        method: this.__sparkfraud.method,
        headers: this.__sparkfraud.headers,
        body: body ? String(body).slice(0, 5000) : null,
        ts: Date.now(),
      };
      record(entry);
      this.addEventListener("load", () => {
        try {
          // 2026-05-22 bug fix: bumped 1MB → 10MB. Truncated JSON fails
          // JSON.parse silently → empty payload → "No item details returned".
          // 21-order OMS response exceeded 1MB. See DISCOVERIES.md.
          entry.responseText = (this.responseText || "").slice(0, 10_000_000);
          entry.responseStatus = this.status;
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log("[APAISuite/SparkFraud capture] installed (fetch + XHR)");
})();
