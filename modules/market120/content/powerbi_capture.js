// modules/market120/content/powerbi_capture.js
//
// MAIN-world content script for app.powerbi.com. Ring-buffers Power BI DAX
// query responses relevant to the ISA reports (ISA Detail, Backroom
// Adjustments). Chained-safe with livedashboard's existing captures on the
// same host — each script patches fetch and calls through the previous
// window.fetch, so multiple modules coexist without collision (see
// modules/livedashboard/content/powerbi_recognition_capture.js:51 for the
// pattern).
//
// Read-only: only reads response bodies via .clone().text(). Never
// initiates a request.
//
// Public API (SW reads via chrome.scripting.executeScript world:"MAIN"):
//   window.__APAISUITE_MARKET120_POWERBI_CAP.all()
//   window.__APAISUITE_MARKET120_POWERBI_CAP.latest()
//   window.__APAISUITE_MARKET120_POWERBI_CAP.findByReport(reportId)
//   window.__APAISUITE_MARKET120_POWERBI_CAP.findBySubstr(s)
//   window.__APAISUITE_MARKET120_POWERBI_CAP.clear()

(() => {
  const KEY = "__APAISUITE_MARKET120_POWERBI_CAP";
  if (window[KEY]) return;

  const RING_MAX = 40;
  const BODY_MAX = 2_097_152; // 2 MB — ISA responses can be large
  const ring = [];

  // Power BI DAX endpoint families:
  //   pbidedicated.windows.net/webapi/capacities/<TENANT>/workloads/QES/(?:Query|QueryExecutionService/.*/query)
  //   wabi-*.analysis.windows.net/public/reports/querydata
  //   wabi-*.analysis.windows.net/.../query
  const URL_MATCHER = /(pbidedicated\.windows\.net\/webapi\/capacities\/[0-9A-Fa-f-]+\/workloads\/QES\/(?:Query|QueryExecutionService\/[^?]*\/query)|wabi[-.].*analysis\.windows\.net\/.*\/(?:querydata|query))/i;

  // Report IDs from Phase 1 discovery (Trey/artifacts/PHASE_1_DISCOVERY.md).
  const ISA_REPORT_IDS = [
    "b4835e03-3718-4b95-919f-8934bc83542c",   // ISA Detail Report (+ ISA Overview page)
    "c929bfda-c409-49f5-b2cb-732370411af3",   // Backroom Adjustments Report
    "ccfb3a4f-77f9-4500-a0bc-fd2e2caba091",   // ISA Watchlist
  ];

  // Real ISA-DAX query bodies (observed via CDP probe 2026-07-26) reference
  // entities: ISA, ISA 2, Alignment. Measures include: Adj Qty, Adj Amt,
  // Adj Date, adj_amt, adj_qty, acctg_dept_nbr, etc.
  function isMarket120Request(body, headers) {
    if (typeof body !== "string") return false;
    // Match if the DAX query references ISA-related entities OR our known reports.
    for (const rid of ISA_REPORT_IDS) if (body.includes(rid)) return true;
    if (/"Entity":\s*"(?:ISA|ISA 2|Alignment)"/i.test(body)) return true;
    if (/Adj[_ ]?(?:Qty|Amt|Date|Reason)|acctg_dept_nbr|adj_(?:amt|qty|date)|Stolen_?Adj/i.test(body)) return true;
    return false;
  }

  function truncate(s) {
    if (typeof s !== "string") return s;
    return s.length > BODY_MAX ? s.slice(0, BODY_MAX) + "…[truncated]" : s;
  }

  function record(entry) {
    entry.capturedAt = Date.now();
    entry.respBody = truncate(entry.respBody);
    ring.push(entry);
    if (ring.length > RING_MAX) ring.shift();
  }

  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
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

    if (!isMarket120Request(reqBody)) {
      return origFetch.apply(this, arguments);
    }

    const resp = await origFetch.apply(this, arguments);
    let respBody = null;
    try { respBody = await resp.clone().text(); } catch {}
    record({ via: "fetch", method, url, reqBody, status: resp.status, respBody });
    return resp;
  };

  // XHR patch — mirrors fetch patch semantics
  const OrigXHR = window.XMLHttpRequest;
  const S_METHOD  = Symbol("m120pbimethod");
  const S_URL     = Symbol("m120pbiurl");

  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (method, url, ...rest) {
    this[S_METHOD] = (method || "GET").toUpperCase();
    this[S_URL] = url;
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.send = function (body) {
    const url = this[S_URL];
    if (this[S_METHOD] === "POST" && URL_MATCHER.test(url) && isMarket120Request(typeof body === "string" ? body : "")) {
      const reqBody = typeof body === "string" ? body : null;
      this.addEventListener("loadend", () => {
        let respBody = null;
        try { respBody = this.responseText; } catch {}
        record({ via: "xhr", method: "POST", url, reqBody, status: this.status, respBody });
      });
    }
    return origSend.call(this, body);
  };

  function findByReport(reportId) {
    if (!reportId) return null;
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      if ((r.reqBody || "").includes(reportId)) return r;
    }
    return null;
  }

  // Search by request-body substring (case-insensitive). Used when reportId
  // isn't in the DAX body — the DAX query only names entities/properties.
  function findByReqBodySubstr(needle) {
    if (typeof needle !== "string" || !needle) return null;
    const n = needle.toLowerCase();
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      const body = r.reqBody || "";
      if (typeof body === "string" && body.toLowerCase().includes(n)) return r;
    }
    return null;
  }

  // Search by response-body substring. Sometimes the measure name we care
  // about only appears in the response descriptor.
  function findByRespBodySubstr(needle) {
    if (typeof needle !== "string" || !needle) return null;
    const n = needle.toLowerCase();
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      const body = r.respBody || "";
      if (typeof body === "string" && body.toLowerCase().includes(n)) return r;
    }
    return null;
  }

  function findBySubstr(needle) {
    if (typeof needle !== "string" || !needle) return null;
    const n = needle.toLowerCase();
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      const body = r.respBody || "";
      if (typeof body === "string" && body.toLowerCase().includes(n)) return r;
    }
    return null;
  }

  // Return ALL envelopes whose response body contains ANY of the needles.
  // Power BI batches KPI cards across multiple QES responses (e.g. ISA
  // Detail's Total Adjusted $ and Total Adjusted Qty land in different
  // responses), so a single-hit finder can only ever populate one KPI.
  // Newest-first, de-duplicated by identity.
  function findAllByRespBodySubstr(needles) {
    const list = Array.isArray(needles) ? needles : [needles];
    const lowered = list.filter((s) => typeof s === "string" && s).map((s) => s.toLowerCase());
    if (!lowered.length) return [];
    const out = [];
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      const body = (r.respBody || "").toLowerCase();
      if (body && lowered.some((n) => body.includes(n))) out.push(r);
    }
    return out;
  }

  window[KEY] = {
    installedAt: Date.now(),
    all:         () => ring.slice(),
    latest:      () => ring.length ? ring[ring.length - 1] : null,
    findByReport,
    findByReqBodySubstr,
    findByRespBodySubstr,
    findAllByRespBodySubstr,
    findBySubstr,
    clear:       () => { ring.length = 0; },
  };

  console.log("[market120 powerbi_capture] installed on", location.host);
})();
