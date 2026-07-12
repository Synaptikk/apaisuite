// modules/digitallocks/content/gscope_capture.js
//
// MAIN-world content script for gscope.walmartlabs.com order resolution.
// Monkey-patches fetch to record auth headers from OMS order searches.
//
// The SW reads captured headers via chrome.scripting.executeScript({ world: "MAIN" })
// and replays them against the /api/gateway/provider-oms/orders endpoint with
// substituted wupc + storeId parameters for the UPC cross-check feature.
//
// Global key is distinct from sparkfraud's capture to avoid collisions.

(() => {
  const KEY = "__APAISUITE_DIGITALLOCKS_GSCOPE_CAP";
  if (window[KEY]) return;

  const OMS_PATTERN = /\/api\/gateway\/provider-oms\/orders/;
  let lastCapture = null;

  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (typeof url === "string" && OMS_PATTERN.test(url)) {
      const headers = {};
      const rawHeaders = init?.headers;
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => { headers[k] = v; });
      } else if (rawHeaders && typeof rawHeaders === "object") {
        Object.assign(headers, rawHeaders);
      }
      const resp = await origFetch.apply(this, arguments);
      lastCapture = { url, headers, capturedAt: Date.now() };
      return resp;
    }
    return origFetch.apply(this, arguments);
  };

  window[KEY] = {
    installedAt: Date.now(),
    getCapture: () => lastCapture,
    clear: () => { lastCapture = null; },
  };

  console.log("[digitallocks gscope_capture] installed (OMS auth header capture)");
})();
