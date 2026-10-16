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
  // AppInfo.ashx is the page's live appID: it loads after js/appInfo.js and
  // overrides it (2026-10-15: appInfo.js says "CVT", AppInfo.ashx "CVT2.0").
  const APP_INFO_PATHS = ["/Protected/CaseVisibility/ashx/AppInfo.ashx", "/Protected/CaseVisibility/js/appInfo.js"];
  // Since ~2026-10-15 Main.ashx also returns an empty roster unless the call
  // carries the page's OAuth token (OAUTH_js.ashx stores it in localStorage;
  // ajax3 sends it as X-OAuth-Token + X-Request-Timestamp).
  const OAUTH_STORAGE_KEY = "oauth_token_radapps3-oauth-js";
  // Since 2026-09-22 Main.ashx returns an EMPTY roster (200, no error) unless
  // the call carries the page's appID; read it so a future ID change follows.
  const FALLBACK_APP_ID = "CVT2.0";
  let appIdPromise = null;

  function toApiDate(yyyyMmDd) {
    return String(yyyyMmDd || "").replace(/-/g, "/");
  }

  function getAppId() {
    appIdPromise ??= (async () => {
      for (const path of APP_INFO_PATHS) {
        try {
          const r = await fetch(path, { credentials: "include", signal: AbortSignal.timeout(10_000) });
          const id = r.ok ? (await r.text()).match(/appInfo_appID\s*=\s*["']([^"']+)["']/)?.[1] : null;
          if (id) return id;
        } catch { /* try the next source */ }
      }
      return FALLBACK_APP_ID;
    })();
    return appIdPromise;
  }

  function oauthHeaders() {
    let token = null;
    try { token = localStorage.getItem(OAUTH_STORAGE_KEY); } catch { /* storage blocked */ }
    if (!token) {
      const error = new Error("CaseVisibility sign-in token missing — reload the CaseVisibility tab and sign in");
      error.errorClass = "AUTH";
      throw error;
    }
    return { "X-OAuth-Token": token, "X-Request-Timestamp": new Date().toISOString() };
  }

  // The server answers a bad appID / stale token with 200 and an empty roster.
  // headcount_changes (per job with call-offs/write-ins) still carries counts,
  // so when it is non-empty use it to turn that silent failure into an error.
  function assertRoster(json) {
    const rows = json?.schedule?.scheduled_associates;
    const scheduled = (json?.headcount_changes || []).reduce((n, h) => n + (Number(h?.nbr_scheduled_plus_write_ins) || 0), 0);
    if (Array.isArray(rows) && rows.length === 0 && scheduled > 0) {
      const error = new Error(`CaseVisibility returned an empty roster (headcount shows ${scheduled} scheduled) — reload the CaseVisibility tab; if it persists, the page's Main.ashx call changed`);
      error.errorClass = "AUTH";
      throw error;
    }
    return json;
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
      headers: { "Accept": "application/json", ...oauthHeaders() },
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
    return assertRoster(await resp.json());
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
