// modules/market120/content/tableau_capture.js
//
// MAIN-world content script for stores.tableau.wal-mart.com. Monkey-patches
// window.fetch (and XHR) to ring-buffer VizQL responses. Chained-safe: if
// another capture script has already patched fetch, we call through to it.
//
// Read-only: only reads response bodies via .clone().text(). Never
// initiates or modifies any request.
//
// Public API (read from SW via chrome.scripting.executeScript world:"MAIN"):
//   window.__APAISUITE_MARKET120_TABLEAU_CAP.all()          → full ring
//   window.__APAISUITE_MARKET120_TABLEAU_CAP.latest()       → newest entry
//   window.__APAISUITE_MARKET120_TABLEAU_CAP.findBySubstr(s) → newest whose
//        response body contains s (case-insensitive)
//   window.__APAISUITE_MARKET120_TABLEAU_CAP.clear()

(() => {
  const KEY = "__APAISUITE_MARKET120_TABLEAU_CAP";
  if (window[KEY]) return;

  const RING_MAX = 40;
  // Body size cap per entry — protects storage / SW payload. Tableau VizQL
  // responses are typically 40-400 KB; we keep the whole body up to this
  // limit and truncate the tail if larger. 1 MB is generous enough for the
  // per-viz "bootstrapSession" response that contains all measure values.
  const BODY_MAX = 1_048_576; // 1 MB
  const ring = [];

  // Match anything under the Tableau site. We tighten this later once we
  // know which endpoint carries the KPI values (VizQL, VizPortal API,
  // bootstrap-session, etc.). Being permissive at first ensures the ring
  // catches the response we need — orchestrator's storage debug dump lets
  // us see all URLs the ring saw when parse fails.
  const URL_MATCHER = /stores\.tableau\.wal-mart\.com\/(?:vizql|vizportal|dataserver|t\/|api\/|Backroom|OnlineGrocery)/i;

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

  // Preserve any previously-installed fetch patch (e.g. livedashboard's
  // Power BI captures if a shared origin ever grows into Tableau).
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const method = (init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();

    if (!URL_MATCHER.test(url)) {
      return origFetch.apply(this, arguments);
    }

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

  // XHR patch (Tableau's server can use XHR under some proxies).
  const OrigXHR = window.XMLHttpRequest;
  const S_METHOD = Symbol("m120tmethod");
  const S_URL    = Symbol("m120turl");

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
      const r = ring[i];
      const body = r.respBody || "";
      if (typeof body === "string" && body.toLowerCase().includes(n)) return r;
    }
    return null;
  }

  window[KEY] = {
    installedAt: Date.now(),
    all:         () => ring.slice(),
    latest:      () => ring.length ? ring[ring.length - 1] : null,
    findBySubstr,
    clear:       () => { ring.length = 0; },
  };

  console.log("[market120 tableau_capture] installed on", location.host);
})();
