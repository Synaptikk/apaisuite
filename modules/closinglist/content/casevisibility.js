// modules/closinglist/content/casevisibility.js
//
// Content script — runs on CaseVisibility pages. Listens for collect-schedule
// messages addressed to this module and calls Main.ashx using the page's
// authenticated session. Browser handles SSO cookies automatically — we never
// read, store, or transmit auth state.
//
// Adapted from ClosingList donor (extension/content/casevisibility.js).
// Changes:
//   - Message filter narrowed to (module="closinglist", type="collect-schedule")
//   - Install guard kept (window.__CLOSINGLIST_CONTENT_INSTALLED__) — same name
//     for compatibility with re-injection across versions.
(() => {
  if (window.__CLOSINGLIST_CONTENT_INSTALLED__) return;
  window.__CLOSINGLIST_CONTENT_INSTALLED__ = true;

  const MODULE_ID = "closinglist";
  const API_PATH  = "/Protected/CaseVisibility/ashx/Main.ashx";
  const APP_INFO_PATH = "/Protected/CaseVisibility/js/appInfo.js";
  // Since 2026-09-22 Main.ashx returns an EMPTY roster (200, no error) unless
  // the call carries the page's appID. The page's own value lives in
  // appInfo.js; read it so a future ID change follows automatically.
  const FALLBACK_APP_ID = "FPTx";
  let appIdPromise = null;

  function toApiDate(yyyyMmDd) {
    return String(yyyyMmDd || "").replace(/-/g, "/");
  }

  function getAppId() {
    appIdPromise ??= fetch(APP_INFO_PATH, { credentials: "include", signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.text() : ""))
      .then((js) => js.match(/appInfo_appID\s*=\s*["']([^"']+)["']/)?.[1] || FALLBACK_APP_ID)
      .catch(() => FALLBACK_APP_ID);
    return appIdPromise;
  }

  async function fetchInit(storeNbr, businessDate) {
    // No jobCodes body on purpose: the page sends its own job-code list, which
    // narrows the roster (238 -> 98 rows for 1458); the closing list wants
    // everyone and applies its own filters.
    const params = new URLSearchParams({
      func: "init",
      appID: await getAppId(),
      storeNbr: String(storeNbr),
      businessDate: toApiDate(businessDate),
    });
    const url = `${API_PATH}?${params.toString()}`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const error = new Error(`Main.ashx HTTP ${resp.status}`);
      error.errorClass = [401, 403].includes(resp.status) ? "AUTH" : "HTTP";
      throw error;
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("json")) {
      const error = new Error(`Unexpected content-type ${ct || "missing"} from CaseVisibility`);
      error.errorClass = ct.toLowerCase().includes("html") ? "AUTH" : "FORMAT";
      throw error;
    }
    return resp.json();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.module !== MODULE_ID) return false;
    if (msg.type === "collect-schedule") {
      fetchInit(msg.storeNbr, msg.businessDate)
        .then((json) => sendResponse({ ok: true, data: json }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err), errorClass: err.errorClass || (err.name === "TimeoutError" ? "TIMEOUT" : "NETWORK") }));
      return true;
    }
    if (msg.type === "ping") {
      sendResponse({ ok: true, pageUrl: location.href });
      return true;
    }
    return false;
  });
})();
