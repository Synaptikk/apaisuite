// modules/sparkscango/content/powerbi_ssg_capture.js
//
// MAIN-world content script — coexists with livedashboard's three existing
// capture scripts (recognition, register, accident) on app.powerbi.com.
// Guards its install with a unique sentinel so a page navigation that
// re-invokes document_start doesn't double-patch fetch/XHR.
//
// Ring-buffers matching QES POSTs (request body + response body + status).
// The SW polls window.__APAISUITE_SSG_CAP.findLatest(pageKey) via
// chrome.scripting.executeScript MAIN world.

(() => {
  const KEY = "__APAISUITE_SSG_CAP";
  if (window[KEY]) return;

  const RING_MAX = 20;
  const ring = [];

  // Power BI's QES workload URL matches all four SSG pages. We differentiate
  // by request body content (each page hits distinct entities in the
  // semantic model). Body markers are populated post-discovery — until then
  // ALL matching QES POSTs are captured and pageKey is left null (the SW's
  // decoder inspects the response body to associate).
  const URL_MATCHER = /pbidedicated\.windows\.net\/webapi\/capacities\/[0-9A-Fa-f-]+\/workloads\/QES\/Query/i;

  // Body markers — populated by pages_registry.js post-discovery. Keeping
  // them here as a placeholder mapping ensures the file compiles today
  // and the SW-side probe tool (dev/ssg_powerbi_probe.js) can update in
  // one place when the real markers are identified.
  const BODY_MARKERS = {
    // Example (unverified) — actual entity names TBD by discovery:
    // scango_exceptions: /"Entity"\s*:\s*"ScanGo_Exceptions"/,
    // spark_exceptions:  /"Entity"\s*:\s*"Spark_Exceptions"/,
    // scango_audits:     /"Entity"\s*:\s*"ScanGo_Audits"/,
    // spark_audits:      /"Entity"\s*:\s*"Spark_Audits"/,
  };

  function pageKeyForRequest(reqBody) {
    if (typeof reqBody !== "string") return null;
    for (const [key, re] of Object.entries(BODY_MARKERS)) {
      if (re.test(reqBody)) return key;
    }
    return null;
  }

  function record(entry) {
    entry.capturedAt = Date.now();
    entry.pageKey = pageKeyForRequest(entry.reqBody);
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
    const url    = typeof input === "string" ? input : input?.url;
    const method = (init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();
    if (method !== "POST" || !URL_MATCHER.test(url)) {
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
  const xhrSetMethod = Symbol("ssgMethod");
  const xhrSetUrl    = Symbol("ssgUrl");
  const xhrHeaders   = Symbol("ssgHeaders");

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
    const url = this[xhrSetUrl];
    if (this[xhrSetMethod] === "POST" && URL_MATCHER.test(url)) {
      const reqHeaders = { ...(this[xhrHeaders] || {}) };
      const reqBody    = typeof body === "string" ? body : null;
      this.addEventListener("loadend", () => {
        let respBody = null;
        try { respBody = this.responseText; } catch {}
        record({ via: "xhr", method: "POST", url, reqHeaders, reqBody, status: this.status, respBody });
      });
    }
    return origSend.call(this, body);
  };

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

  window[KEY] = {
    installedAt: Date.now(),
    all:         () => ring.slice(),
    latest:      () => (ring.length ? ring[ring.length - 1] : null),
    findLatest,
    clear:       () => { ring.length = 0; },
    // Discovery-only: dumps all captured metadata WITHOUT the response body
    // (which may contain PII). Callers requesting full bodies must pass
    // includeBodies: true and are responsible for redaction downstream.
    dumpMetadata: () => ring.map((r) => ({
      via: r.via, url: r.url, status: r.status, pageKey: r.pageKey,
      reqBodyLen: r.reqBody?.length ?? 0, respBodyLen: r.respBody?.length ?? 0,
      capturedAt: r.capturedAt,
    })),
  };

  console.log("[sparkscango ssg_capture] installed (MAIN-world fetch+XHR patch on Power BI QES workload)");
})();
