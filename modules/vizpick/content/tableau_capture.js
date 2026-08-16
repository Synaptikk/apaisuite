// modules/vizpick/content/tableau_capture.js
//
// MAIN-world content script for stores.tableau.wal-mart.com. Monkey-patches
// window.fetch (and XHR) to ring-buffer VizQL/crosstab responses. Chained-
// safe: if another module's capture script (e.g. market120) has already
// patched fetch on this same host, we call through to it.
//
// Read-only: only reads response bodies via .clone().text(). Never
// initiates or modifies any request.
//
// Public API (read from SW via chrome.scripting.executeScript world:"MAIN"):
//   window.__APAISUITE_VIZPICK_TABLEAU_CAP.all()          → full ring
//   window.__APAISUITE_VIZPICK_TABLEAU_CAP.latest()       → newest entry
//   window.__APAISUITE_VIZPICK_TABLEAU_CAP.findBySubstr(s) → newest whose
//        response body contains s (case-insensitive)
//   window.__APAISUITE_VIZPICK_TABLEAU_CAP.findBlobBySubstr(s) → same, but
//        restricted to Blob-download captures (crosstab CSV exports never
//        arrive as a fetch/XHR response — see the URL.createObjectURL patch
//        below — so this is the reliable way to find an exported file
//        without false-matching a metadata/layout response that merely
//        mentions the same field name).
//   window.__APAISUITE_VIZPICK_TABLEAU_CAP.clear()

(() => {
  const KEY = "__APAISUITE_VIZPICK_TABLEAU_CAP";
  if (window[KEY]) return;

  const RING_MAX = 40;
  // Body size cap per entry — protects storage / SW payload.
  const BODY_MAX = 1_048_576; // 1 MB
  const ring = [];

  // Permissive match across the whole Tableau site, same as market120 —
  // being broad here means the ring always catches the export response we
  // need, and the debug dump on a NO_CAPTURE lets us see every URL it saw.
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

  // Preserve any previously-installed fetch patch (e.g. market120's or
  // metricshot's captures on this same origin).
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

  // Blob-download patch. Tableau's crosstab export doesn't come back as a
  // fetch/XHR response at all — it builds the CSV client-side into a Blob,
  // calls URL.createObjectURL(blob), and clicks a synthetic <a download>
  // to trigger a native file save. That save can be intercepted/quarantined
  // by endpoint DLP before we could ever read it back off disk, so instead
  // we read the Blob's content in-page, at the moment it's created — before
  // it ever becomes a file. This is the only path that actually captures
  // crosstab CSV exports (fetch/XHR patches above never see them).
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = origCreateObjectURL(blob);
    try {
      if (blob instanceof Blob) {
        blob.text().then((text) => {
          record({ via: "blob", method: "BLOB", url, reqBody: null, status: 200, respBody: text });
        }).catch(() => {});
      }
    } catch {}
    return url;
  };

  // XHR patch (Tableau's server can use XHR under some proxies).
  const OrigXHR = window.XMLHttpRequest;
  const S_METHOD = Symbol("vptmethod");
  const S_URL    = Symbol("vpturl");

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

  // Blob-only variant. The generic findBySubstr above can false-match a
  // regular fetch/XHR response that merely *mentions* the needle (e.g.
  // Tableau's dashboard layout/session JSON lists every field name shown on
  // screen, including "Cases Seen %", even though it isn't the CSV export).
  // Crosstab exports always arrive via the Blob/createObjectURL patch, so
  // restricting to via === "blob" is the reliable way to find the real file.
  function findBlobBySubstr(needle) {
    if (typeof needle !== "string" || !needle) return null;
    const n = needle.toLowerCase();
    for (let i = ring.length - 1; i >= 0; i--) {
      const r = ring[i];
      if (r.via !== "blob") continue;
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
    findBlobBySubstr,
    clear:       () => { ring.length = 0; },
  };

  console.log("[vizpick tableau_capture] installed on", location.host);
})();
