// modules/registerls/content/powerbi_cash_recycler_capture.js
//
// MAIN-world content script for app.powerbi.com — the "Cash Recycler" report
// (reportId 59fc9ae6-9d65-4277-b2f6-79fe4b5a10a4): every till check-in /
// check-out / cash advance / vault advance / pickup, with the associate.
// Ring-buffers the report's own QES query for the Cash_Recycler entity so the
// service worker can replay it with a store + date filter.
//
// Same stacked-patch arrangement as livedashboard/content/powerbi_register_capture.js:
// each capture script filters for its own entity and chains to the previously
// installed fetch/XHR.

(() => {
  const KEY = "__APAISUITE_REGISTERLS_CR_CAP";
  if (window[KEY]) return;

  const RING_MAX = 12;
  const ring = [];
  const URL_MATCHER = /pbidedicated\.windows\.net\/webapi\/capacities\/[0-9A-Fa-f-]+\/workloads\/QES\/Query/i;
  const matchesEntity = (body) => typeof body === "string" && /"Entity":"Cash_Recycler"/.test(body);

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
  const M = Symbol("crMethod"), U = Symbol("crUrl"), H = Symbol("crHeaders");
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

  // The table visual's query: selects Transaction_Time + Associate_Name.
  const isTableQuery = (b) => /"Property":"Transaction_Time"/.test(b) && /"Property":"Associate_Name"/.test(b);
  function findLatest(pred) { for (let i = ring.length - 1; i >= 0; i--) { const r = ring[i]; if (r.reqBody && (r.status === 200 || r.status === 0) && pred(r.reqBody)) return r; } return null; }

  window[KEY] = {
    installedAt: Date.now(),
    all:       () => ring.slice(),
    findTable: () => findLatest(isTableQuery),
    clear:     () => { ring.length = 0; },
    rawFetch:  (...args) => origFetch.apply(window, args),
  };
  console.log("[registerls cash_recycler_capture] installed (MAIN-world fetch+XHR patch on Cash_Recycler)");
})();
