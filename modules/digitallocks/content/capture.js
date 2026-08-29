// modules/digitallocks/content/capture.js
//
// MAIN-world content script for app.powerbi.com. Monkey-patches fetch +
// XMLHttpRequest to record the Power BI dataset queries the report fires.
//
// We don't drive the UI to filter, and we no longer replay the report's own
// query either — that inherited whatever slicers the analyst had left set.
// What the SW actually needs from here is TRANSPORT: the tenant-specific QES
// url, the self-contained MWCToken, and the modelId. It builds its own query
// around them (see ../lib/powerBiQuery.js).
//
// So ANY captured QES request is useful, not just the data grid's. The ring is
// exposed wholesale via all(); the SW picks from it inside its injected
// function (service.js::waitForTransport) rather than serialising captured
// response bodies back across the executeScript boundary.
//
// Capture is stored on window.__APAISUITE_DIGITALLOCKS_CAP and read by the
// SW via chrome.scripting.executeScript({ world: "MAIN" }).
//
// Naming convention matches sparkfraud/content/capture.js to keep MAIN-world
// globals collision-free across modules.

(() => {
  const KEY = "__APAISUITE_DIGITALLOCKS_CAP";
  if (window[KEY]) return;

  const RING_MAX = 12;
  const ring = [];

  // Match POSTs to the pbidedicated QES endpoint — that's the dataset-query
  // API. The hostname has a tenant-specific UUID prefix, so we wildcard.
  const matchesQesEndpoint = (url) =>
    typeof url === "string" &&
    /pbidedicated\.windows\.net\/.+\/QES\/QueryExecutionService\/.+\/query(\?|$)/i.test(url);

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
    if (method !== "POST" || !matchesQesEndpoint(url)) {
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
  const xhrSetMethod = Symbol("dlMethod");
  const xhrSetUrl = Symbol("dlUrl");
  const xhrHeaders = Symbol("dlHeaders");

  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (method, url, ...rest) {
    this[xhrSetMethod] = (method || "GET").toUpperCase();
    this[xhrSetUrl] = url;
    this[xhrHeaders] = {};
    return origOpen.call(this, method, url, ...rest);
  };

  const origSetHeader = OrigXHR.prototype.setRequestHeader;
  OrigXHR.prototype.setRequestHeader = function (name, value) {
    if (this[xhrHeaders]) this[xhrHeaders][name] = value;
    return origSetHeader.call(this, name, value);
  };

  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.send = function (body) {
    if (this[xhrSetMethod] === "POST" && matchesQesEndpoint(this[xhrSetUrl])) {
      const reqHeaders = { ...(this[xhrHeaders] || {}) };
      const reqBody = typeof body === "string" ? body : null;
      const url = this[xhrSetUrl];
      this.addEventListener("loadend", () => {
        let respBody = null;
        try { respBody = this.responseText; } catch {}
        record({ via: "xhr", method: "POST", url, reqHeaders, reqBody, status: this.status, respBody });
      });
    }
    return origSend.call(this, body);
  };

  // ── public reader ──────────────────────────────────────────────────
  window[KEY] = {
    installedAt: Date.now(),
    all: () => ring.slice(),
    clear: () => { ring.length = 0; },
  };

  console.log("[digitallocks capture] installed (MAIN-world fetch+XHR patch on QES endpoint)");
})();
