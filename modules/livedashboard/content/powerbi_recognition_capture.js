// modules/livedashboard/content/powerbi_recognition_capture.js
//
// MAIN-world content script for app.powerbi.com — specifically the
// Field_Dashboard "Safety Observations" report. Monkey-patches fetch +
// XMLHttpRequest to ring-buffer the QES bundle POST whose body references
// Description_of_the_Safety_Observation (the inner query backing the
// "Recognition for Stores" table).
//
// The QES endpoint shape is:
//   .../webapi/capacities/<TENANT>/workloads/QES/QueryExecutionService/automatic/public/query
// The bundle includes ~9 inner queries; the response.results[] array carries
// one descriptor+dsr per inner query. The SW iterates results[] and picks
// the one whose descriptor.Select names Description_of_the_Safety_Observation.
//
// Coexists with powerbi_register_capture.js: both monkey-patch the same
// fetch/XHR, each saves the previously-installed handler and chains through.

(() => {
  const KEY = "__APAISUITE_LIVEDASHBOARD_RECOGNITION_CAP";
  if (window[KEY]) return;

  const RING_MAX = 12;
  const ring = [];

  const URL_MATCHER = /pbidedicated\.windows\.net\/webapi\/capacities\/[0-9A-Fa-f-]+\/workloads\/QES\/Query/i;
  const BODY_MARKER = /Description_of_the_Safety_Observation/;

  function matchesRecognitionEntity(body) {
    return typeof body === "string" && BODY_MARKER.test(body);
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
    if (!matchesRecognitionEntity(reqBody)) {
      return origFetch.apply(this, arguments);
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
  const xhrSetMethod = Symbol("rcMethod");
  const xhrSetUrl    = Symbol("rcUrl");
  const xhrHeaders   = Symbol("rcHeaders");

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
    if (this[xhrSetMethod] === "POST" && URL_MATCHER.test(url) && matchesRecognitionEntity(typeof body === "string" ? body : "")) {
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

  function findLatest() {
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      if (!r.reqBody) continue;
      if (r.status === 200 || r.status === 0) return r;
    }
    return null;
  }

  window[KEY] = {
    installedAt: Date.now(),
    all:         () => ring.slice(),
    latest:      () => ring.length ? ring[ring.length - 1] : null,
    findRecognition: findLatest,
    clear:        () => { ring.length = 0; },
  };

  console.log("[livedashboard recognition_capture] installed (MAIN-world fetch+XHR patch on Description_of_the_Safety_Observation)");
})();
