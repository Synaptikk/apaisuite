// modules/registerls/content/powerbi_cft_capture.js
//
// MAIN-world content script for app.powerbi.com — the "Cash Fund Transfers"
// report (reportId 22a4bd64-8f29-4be0-bf3a-15834366dee9): every CFT keyed at
// a store with business date, input date/time, account, recipient, reason
// and amount. Ring-buffers the report's own QES query for the CFT_Data entity
// so the service worker can replay it with a store + date filter.
//
// Same stacked-patch arrangement as powerbi_cash_recycler_capture.js: each
// capture script filters for its own entity and chains to the previously
// installed fetch/XHR.

(() => {
  const KEY = "__APAISUITE_REGISTERLS_CFT_CAP";
  if (window[KEY]) return;

  const RING_MAX = 12;
  const ring = [];
  const URL_MATCHER = /pbidedicated\.windows\.net\/webapi\/capacities\/[0-9A-Fa-f-]+\/workloads\/QES\/Query/i;
  const matchesEntity = (body) => typeof body === "string" && /"Entity":"CFT_Data"/.test(body);

  function record(entry) { entry.capturedAt = Date.now(); ring.push(entry); if (ring.length > RING_MAX) ring.shift(); }
  function headersToObject(h) {
    if (!h) return {};
    if (h instanceof Headers) { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h };
  }

  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url    = typeof input === "string" ? input : input?.url;
    const method = (init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();
    if (method !== "POST" || !URL_MATCHER.test(url)) return origFetch.apply(this, arguments);
    let reqBody = null;
    try { if (typeof init?.body === "string") reqBody = init.body; } catch {}
    if (!matchesEntity(reqBody)) return origFetch.apply(this, arguments);
    const reqHeaders = headersToObject(init?.headers);
    const resp = await origFetch.apply(this, arguments);
    let respBody = null;
    try { respBody = await resp.clone().text(); } catch {}
    record({ via: "fetch", method, url, reqHeaders, reqBody, status: resp.status, respBody });
    return resp;
  };

  const OrigXHR = window.XMLHttpRequest;
  const M = Symbol("cftMethod"), U = Symbol("cftUrl"), H = Symbol("cftHeaders");
  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (method, url, ...rest) { this[M] = (method || "GET").toUpperCase(); this[U] = url; this[H] = {}; return origOpen.call(this, method, url, ...rest); };
  const origSetHeader = OrigXHR.prototype.setRequestHeader;
  OrigXHR.prototype.setRequestHeader = function (name, value) { if (this[H]) this[H][name] = value; return origSetHeader.call(this, name, value); };
  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.send = function (body) {
    const url = this[U];
    if (this[M] === "POST" && URL_MATCHER.test(url) && matchesEntity(typeof body === "string" ? body : "")) {
      const reqHeaders = { ...(this[H] || {}) };
      this.addEventListener("loadend", () => { let respBody = null; try { respBody = this.responseText; } catch {} record({ via: "xhr", method: "POST", url, reqHeaders, reqBody: body, status: this.status, respBody }); });
    }
    return origSend.call(this, body);
  };

  // The table visual's query: selects CFT_REASON + INPUT_TIME (the slicers
  // and the total tile select neither).
  const isTableQuery = (b) => /"Property":"CFT_REASON"/.test(b) && /"Property":"INPUT_TIME"/.test(b);
  function findLatest(pred) { for (let i = ring.length - 1; i >= 0; i--) { const r = ring[i]; if (r.reqBody && (r.status === 200 || r.status === 0) && pred(r.reqBody)) return r; } return null; }

  window[KEY] = {
    installedAt: Date.now(),
    all:       () => ring.slice(),
    findTable: () => findLatest(isTableQuery),
    clear:     () => { ring.length = 0; },
    rawFetch:  (...args) => origFetch.apply(window, args),
  };
  console.log("[registerls cft_capture] installed (MAIN-world fetch+XHR patch on CFT_Data)");
})();
