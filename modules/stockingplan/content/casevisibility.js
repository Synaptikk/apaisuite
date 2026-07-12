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

  function toApiDate(yyyyMmDd) {
    return String(yyyyMmDd || "").replace(/-/g, "/");
  }

  async function fetchInit(storeNbr, businessDate) {
    const params = new URLSearchParams({
      func: "init",
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
