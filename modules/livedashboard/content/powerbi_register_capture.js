// modules/livedashboard/content/powerbi_register_capture.js
//
// MAIN-world content script for app.powerbi.com — specifically the
// register long/short report. Monkey-patches fetch + XMLHttpRequest to
// ring-buffer the QES queries that the report fires, identified by the
// entity name "qryLongShortSignOn".
//
// The endpoint pattern for this report is DIFFERENT from digitallocks':
//   register report: pbidedicated.windows.net/webapi/capacities/<TENANT>/workloads/QES/Query
//   digital locks:    pbidedicated.windows.net/<...>/QES/QueryExecutionService/<...>/query
// So this script lives separately and does not collide with digitallocks'
// capture (both monkey-patch fetch, but in a stacked fashion — each filters
// for its own URL pattern and chains to the previously-installed handler).
//
// The SW reads two query envelopes:
//   - "grid"     — register × date pivot of long_short_amt (the dollar values)
//   - "operator" — per-shift dimensions (Operator_Nbr ↔ register/date)
// Both selected on the entity "qryLongShortSignOn".

(() => {
  const KEY = "__APAISUITE_LIVEDASHBOARD_REGISTER_CAP";
  if (window[KEY]) return;

  const RING_MAX = 24;
  const ring = [];

  // Endpoint pattern unique to this report (see dev/REGISTER_POWERBI_FINDINGS.md).
  const URL_MATCHER = /pbidedicated\.windows\.net\/webapi\/capacities\/[0-9A-Fa-f-]+\/workloads\/QES\/Query/i;

  // Body must reference our entity to be relevant.
  function matchesRegisterEntity(body) {
    return typeof body === "string" && /qryLongShortSignOn/i.test(body);
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
    if (!matchesRegisterEntity(reqBody)) {
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
  const xhrSetMethod = Symbol("rgMethod");
  const xhrSetUrl    = Symbol("rgUrl");
  const xhrHeaders   = Symbol("rgHeaders");

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
    if (this[xhrSetMethod] === "POST" && URL_MATCHER.test(url) && matchesRegisterEntity(typeof body === "string" ? body : "")) {
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

  // ── Classification helpers (run on captured bodies, MAIN-world side) ──
  //
  // Identifying which captured request is which:
  //   GRID     — selects `register_nbr`, references `action_date`, and uses
  //              the "FilteredValues" measure (the pivoted long_short_amt).
  //   OPERATOR — selects Sign_On_Time, Sign_Off_Time, Operator_Nbr (the
  //              dimensions query — per-shift per-register).
  function isGridQuery(body) {
    return /\"Property\":\"FilteredValues\"/.test(body)
        && /\"Property\":\"action_date\"/.test(body)
        && /\"Property\":\"register_nbr\"/.test(body);
  }
  function isOperatorQuery(body) {
    return /\"Property\":\"Sign_On_Time\"/.test(body)
        && /\"Property\":\"Sign_Off_Time\"/.test(body)
        && /\"Property\":\"Operator_Nbr\"/.test(body);
  }

  function findLatest(predicate) {
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      if (!r.reqBody) continue;
      if ((r.status === 200 || r.status === 0) && predicate(r.reqBody)) return r;
    }
    return null;
  }

  window[KEY] = {
    installedAt: Date.now(),
    all:         () => ring.slice(),
    latest:      () => ring.length ? ring[ring.length - 1] : null,
    findGrid:     () => findLatest(isGridQuery),
    findOperator: () => findLatest(isOperatorQuery),
    clear:        () => { ring.length = 0; },
  };

  console.log("[livedashboard register_capture] installed (MAIN-world fetch+XHR patch on qryLongShortSignOn)");
})();
