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

  function toApiDate(yyyyMmDd) {
    return String(yyyyMmDd || "").replace(/-/g, "/");
  }

  async function fetchInit(storeNbr, businessDate) {
    const params = new URLSearchParams({
      func: "init",
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
