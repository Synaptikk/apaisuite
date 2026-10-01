// modules/stockingplan/content/casevisibility.js
//
// Content script — runs on CaseVisibility pages alongside the closinglist
// content script. Separate install guard + module filter prevents collision.
// Calls Main.ashx?func=init to fetch the schedule for the stocking-plan view.
(() => {
  if (window.__STOCKINGPLAN_CONTENT_INSTALLED__) return;
  window.__STOCKINGPLAN_CONTENT_INSTALLED__ = true;

  const MODULE_ID = "stockingplan";
  const API_PATH  = "/Protected/CaseVisibility/ashx/Main.ashx";
  const APP_INFO_PATH = "/Protected/CaseVisibility/js/appInfo.js";
  // Since 2026-09-22 Main.ashx returns an EMPTY roster (200, no error) unless
  // the call carries the page's appID; read it from appInfo.js.
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
    const params = new URLSearchParams({
      func: "init",
      appID: await getAppId(),
      storeNbr: String(storeNbr),
      businessDate: toApiDate(businessDate),
    });
    const resp = await fetch(`${API_PATH}?${params.toString()}`, {
      method: "POST",
      credentials: "include",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Main.ashx ${resp.status}: ${body.slice(0, 200)}`);
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("json")) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Unexpected content-type ${ct}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.module !== MODULE_ID) return false;
    if (msg.type === "collect-schedule") {
      fetchInit(msg.storeNbr, msg.businessDate)
        .then((json) => sendResponse({ ok: true, data: json }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true;
    }
    if (msg.type === "ping") {
      sendResponse({ ok: true, pageUrl: location.href });
      return true;
    }
    return false;
  });
})();
