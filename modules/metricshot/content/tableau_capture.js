// modules/metricshot/content/tableau_capture.js
//
// MAIN-world content script for stores.tableau.wal-mart.com. Monkey-patches
// window.fetch (and XHR) to ring-buffer VizQL responses so the SW can pull
// the row data for whichever worksheet the current metric needs.
//
// Same pattern as modules/market120/content/tableau_capture.js. Kept as its
// own module-scoped global so the two modules can coexist on the same page
// without collisions. If a third Tableau-scraping module ever ships, this is
// the point to generalize into shared/tableau_capture.js.
//
// Read-only: only reads response bodies via .clone().text(). Never modifies
// requests. Chained-safe: preserves any previously-installed fetch patch.
//
// Public API (SW reads via chrome.scripting.executeScript world:"MAIN"):
//   window.__APAISUITE_METRICSHOT_TABLEAU_CAP.all()
//   window.__APAISUITE_METRICSHOT_TABLEAU_CAP.latest()
//   window.__APAISUITE_METRICSHOT_TABLEAU_CAP.findBySubstr(s) — newest whose
//     response body contains s (case-insensitive)
//   window.__APAISUITE_METRICSHOT_TABLEAU_CAP.findAllBySubstr(s) — every hit
//   window.__APAISUITE_METRICSHOT_TABLEAU_CAP.clear()

(() => {
  const KEY = "__APAISUITE_METRICSHOT_TABLEAU_CAP";
  if (window[KEY]) return;

  const RING_MAX = 60;
  const BODY_MAX = 4_194_304; // 4 MB — VizPick Location Details response can be large
  const ring = [];

  const URL_MATCHER = /stores\.tableau\.wal-mart\.com\/(?:vizql|vizportal|dataserver|t\/|api\/|OnlineGrocery)/i;

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

    if (!URL_MATCHER.test(url)) return origFetch.apply(this, arguments);

    let reqBody = null;
    if (init?.body != null) {
      try {
        if (typeof init.body === "string") reqBody = init.body;
        else if (init.body instanceof URLSearchParams) reqBody = init.body.toString();
      } catch {}
    }
    const resp = await origFetch.apply(this, arguments);
    let respBody = null;
    try { respBody = await resp.clone().text(); } catch {}
    record({ via: "fetch", method, url, reqBody, status: resp.status, respBody });
    return resp;
  };

  const OrigXHR = window.XMLHttpRequest;
  const S_METHOD = Symbol("mstmethod");
  const S_URL    = Symbol("msturl");

  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (method, url, ...rest) {
    this[S_METHOD] = (method || "GET").toUpperCase();
    this[S_URL]    = url;
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.send = function (body) {
    const url = this[S_URL];
    if (URL_MATCHER.test(url)) {
      const reqBody = typeof body === "string" ? body : null;
      const method = this[S_METHOD] || "GET";
      this.addEventListener("loadend", () => {
        let respBody = null;
        try { respBody = this.responseText; } catch {}
        record({ via: "xhr", method, url, reqBody, status: this.status, respBody });
      });
    }
    return origSend.call(this, body);
  };

  function findBySubstr(needle) {
    if (typeof needle !== "string" || !needle) return null;
    const n = needle.toLowerCase();
    for (let i = ring.length - 1; i >= 0; i--) {
      const body = ring[i].respBody || "";
      if (typeof body === "string" && body.toLowerCase().includes(n)) return ring[i];
    }
    return null;
  }

  function findAllBySubstr(needle) {
    if (typeof needle !== "string" || !needle) return [];
    const n = needle.toLowerCase();
    const out = [];
    for (let i = ring.length - 1; i >= 0; i--) {
      const body = ring[i].respBody || "";
      if (typeof body === "string" && body.toLowerCase().includes(n)) out.push(ring[i]);
    }
    return out;
  }

  window[KEY] = {
    installedAt: Date.now(),
    all:              () => ring.slice(),
    latest:           () => ring.length ? ring[ring.length - 1] : null,
    findBySubstr,
    findAllBySubstr,
    clear:            () => { ring.length = 0; },
  };

  console.log("[metricshot tableau_capture] installed on", location.host);
})();
