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
//
// 2026-09-03: this buffer had been empty on Order Resolution since
// 2026-08-20. Observed live: the page fired the OMS XHR on every driver
// retry, the grid showed "10 orders found", and this buffer held exactly one
// entry (the shell's import-map fetch). Two causes, both fixed here:
//
//   1. sparkrisk's capture.js (same pages, runs first) replaced the
//      XMLHttpRequest CONSTRUCTOR with a wrapper. `XMLHttpRequest.prototype`
//      was then the wrapper's empty prototype, this file's patch landed on
//      it, and no XHR ever went through. install() now reaches the real
//      prototype through an instance. (sparkrisk was also changed to patch
//      the prototype, so the two compose in either order.)
//   2. Quantum Metric, a page script, wraps window.fetch and routes calls
//      through a hidden same-origin <iframe>'s pristine fetch, out of reach
//      of a top-window patch. Content scripts do not run in about:blank
//      children, and the reference is grabbed synchronously on creation, so
//      the parent hooks the contentWindow / contentDocument getters and
//      installs the same patch into any same-origin child the page reaches
//      for, recording into the TOP buffer so the service worker sees one
//      list.

(() => {
  if (window.__APAISUITE_SPARKFRAUD_CAP) return; // already installed

  const cap = [];
  window.__APAISUITE_SPARKFRAUD_CAP = cap;

  function record(entry) {
    cap.push(entry);
    if (cap.length > 200) cap.splice(0, cap.length - 200);
  }

  // Mark installed windows with a non-enumerable flag so a child window
  // reached through both getters (or re-read many times) is patched once.
  const INSTALLED = "__APAISUITE_SPARKFRAUD_CAP_INSTALLED";

  function install(win) {
    try {
      if (!win || win[INSTALLED]) return;
      Object.defineProperty(win, INSTALLED, { value: true, configurable: true });
    } catch (_) { return; } // cross-origin — nothing to do

    // ── fetch ─────────────────────────────────────────────────────
    const origFetch = win.fetch;
    const WinHeaders = win.Headers;
    win.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      const headers = {};
      if (input && typeof input !== "string" && input.headers) {
        try { for (const [k, v] of input.headers.entries()) headers[k.toLowerCase()] = v; } catch (_) {}
      }
      if (init && init.headers) {
        const h = init.headers;
        try {
          if ((WinHeaders && h instanceof WinHeaders) || h instanceof Headers) {
            for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
          } else if (Array.isArray(h)) {
            for (const [k, v] of h) headers[k.toLowerCase()] = v;
          } else {
            for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
          }
        } catch (_) {}
      }
      const body = init && init.body ? String(init.body).slice(0, 5000) : null;
      const entry = { via: win === window ? "fetch" : "fetch-iframe", url, method, headers, body, ts: Date.now() };
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
    const XHR = win.XMLHttpRequest;
    if (!XHR) return;
    // Patch the REAL prototype. If another script (sparkrisk's capture did
    // this until 2026-09-03; page code or other extensions still might)
    // replaced the constructor with a wrapper, `XHR.prototype` is the
    // wrapper's empty prototype and a patch there is never called. The
    // instances such wrappers hand out are still real XHRs, so their
    // prototype is the one that matters.
    let proto = XHR.prototype;
    if (typeof proto.open !== "function") {
      try { proto = Object.getPrototypeOf(new XHR()); } catch (_) {}
    }
    if (!proto || typeof proto.open !== "function") return;
    const origOpen = proto.open;
    const origSetHeader = proto.setRequestHeader;
    const origSend = proto.send;
    const via = win === window ? "xhr" : "xhr-iframe";

    proto.open = function (method, url) {
      this.__sparkfraud = { method, url, headers: {} };
      return origOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      if (this.__sparkfraud) this.__sparkfraud.headers[String(name).toLowerCase()] = value;
      return origSetHeader.apply(this, arguments);
    };
    proto.send = function (body) {
      if (this.__sparkfraud) {
        const entry = {
          via,
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
  }

  install(window);

  // ── same-origin child frames ──────────────────────────────────
  // Patch a child window the moment the page reaches for it. Both getters
  // are hooked because either `iframe.contentWindow.fetch` or
  // `iframe.contentDocument.defaultView.fetch` yields the clean function.
  // Cross-origin children throw on access inside install() and are skipped.
  function hookGetter(proto, prop, toWindow) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || typeof desc.get !== "function") return;
    const origGet = desc.get;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const value = origGet.call(this);
        try { install(toWindow(value)); } catch (_) {}
        return value;
      },
    });
  }
  try {
    hookGetter(HTMLIFrameElement.prototype, "contentWindow", w => w);
    hookGetter(HTMLIFrameElement.prototype, "contentDocument", d => d && d.defaultView);
  } catch (e) {
    console.warn("[APAISuite/SparkFraud capture] iframe getter hook failed:", e);
  }

  console.log("[APAISuite/SparkFraud capture] installed (fetch + XHR, top + same-origin iframes)");
})();
