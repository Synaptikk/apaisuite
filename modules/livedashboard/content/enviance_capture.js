// modules/livedashboard/content/enviance_capture.js
//
// MAIN-world content script for go.enviance.com. Monkey-patches fetch +
// XMLHttpRequest to ring-buffer the Enviance query-builder requests that
// the SPA fires after load. The SW reads the latest WfAdapt.getWfs
// envelope via chrome.scripting.executeScript({ world: "MAIN" }) and
// replays it to get a fresh compliance task list.
//
// Naming convention matches sparkfraud/digitallocks/content/capture.js to
// keep MAIN-world globals collision-free across modules.

(() => {
  const KEY = "__APAISUITE_LIVEDASHBOARD_ENV_CAP";
  if (window[KEY]) return;

  const RING_MAX = 16;
  const ring = [];

  // The "WfAdapt.getWfs" call is the compliance task list. Path looks like
  //   /CustomApp/<systemId>/app/core/query-builder/query-template.eqlx?name=<panel>__WfAdapt.getWfs
  // The panel prefix is per-customization but the suffix is stable.
  const WFS_MATCHER = /\/app\/core\/query-builder\/query-template\.eqlx\?name=.*__WfAdapt\.getWfs\b/i;

  function matchesWfs(url) {
    return typeof url === "string" && WFS_MATCHER.test(url);
  }

  function record(entry) {
    entry.capturedAt = Date.now();
    ring.push(entry);
    if (ring.length > RING_MAX) ring.shift();
  }

  function headersToObject(h) {
    if (!h) return {};
    if (h instanceof Headers) {
      const o = {};
      h.forEach((v, k) => { o[k] = v; });
      return o;
    }
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h };
  }

  // ── fetch patch ────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const method = (init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();
    if (method !== "POST" || !matchesWfs(url)) {
      return origFetch.apply(this, arguments);
    }

    let reqBody = null;
    if (init?.body != null) {
      try {
        if (typeof init.body === "string") reqBody = init.body;
        else if (init.body instanceof URLSearchParams) reqBody = init.body.toString();
      } catch {}
    }
    const reqHeaders = headersToObject(init?.headers);
    const resp = await origFetch.apply(this, arguments);
    let respBody = null;
    try { respBody = await resp.clone().text(); } catch {}
    record({ via: "fetch", method, url, reqHeaders, reqBody, status: resp.status, respBody });
    return resp;
  };

  // ── XHR patch ──────────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  const xhrSetMethod = Symbol("evMethod");
  const xhrSetUrl    = Symbol("evUrl");
  const xhrHeaders   = Symbol("evHeaders");
  const xhrBody      = Symbol("evBody");

  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (method, url, ...rest) {
    this[xhrSetMethod] = (method || "GET").toUpperCase();
    this[xhrSetUrl]    = url;
    this[xhrHeaders]   = {};
    return origOpen.call(this, method, url, ...rest);
  };

  const origSetHeader = OrigXHR.prototype.setRequestHeader;
  OrigXHR.prototype.setRequestHeader = function (name, value) {
    if (this[xhrHeaders]) this[xhrHeaders][name] = value;
    return origSetHeader.call(this, name, value);
  };

  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.send = function (body) {
    if (this[xhrSetMethod] === "POST" && matchesWfs(this[xhrSetUrl])) {
      this[xhrBody] = typeof body === "string" ? body : null;
      const captured = {
        via:        "xhr",
        method:     "POST",
        url:        this[xhrSetUrl],
        reqHeaders: { ...(this[xhrHeaders] || {}) },
        reqBody:    this[xhrBody],
      };
      this.addEventListener("loadend", () => {
        let respBody = null;
        try { respBody = this.responseText; } catch {}
        record({ ...captured, status: this.status, respBody });
      });
    }
    return origSend.call(this, body);
  };

  // ── public reader ──────────────────────────────────────────────────
  window[KEY] = {
    installedAt: Date.now(),
    all:         () => ring.slice(),
    latest:      () => ring.length ? ring[ring.length - 1] : null,
    // For the SW: returns the most recent successful WfAdapt.getWfs
    // request envelope (URL, headers, body) so it can be replayed from
    // chrome-extension:// origin. respBody is also returned in case the
    // SW wants to short-circuit and just decode the captured response.
    findCompliance: () => {
      for (let i = ring.length - 1; i >= 0; i--) {
        const r = ring[i];
        if (r.status === 200 || r.status === 0) return r;
      }
      return null;
    },
    clear: () => { ring.length = 0; },
  };

  console.log("[livedashboard env_capture] installed (MAIN-world fetch+XHR patch on Enviance WfAdapt.getWfs)");
})();
