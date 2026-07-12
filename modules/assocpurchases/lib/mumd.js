// modules/assocpurchases/lib/mumd.js
//
// Active MUMD detail report fetch — runs in the SW.
//
// Uses chrome.scripting.executeScript({ world: "MAIN" }) on a
// sf-reports-ui.walmart.com tab so the browser's full auth context
// (corporate proxy SSO injection, cookies, page JS interceptors) handles
// authentication automatically — same pattern as Workvivo / AurorBuddy.
// The SW never needs to manage or replay any auth tokens itself.

import { createAuth, SSO_SELECTORS } from "../../../shared/auth.js";

const MUMD_URL  = "https://sf-reports-ui.walmart.com/mumd/detail-mumd-report";
const MUMD_HOST = "sf-reports-ui.walmart.com";
const MUMD_API  = "https://sf-reports-api.walmart.com/v1/reports/detail";

const _auth = createAuth("assocpurchases");

// ── Column / field mapping ─────────────────────────────────────────────────

// Column headers in DOM order — used as the returned `headers` array.
export const DOM_COLUMNS = [
  "Dept", "Event Description", "UPC Nbr", "Item Nbr", "Item Description",
  "Old Sell", "New Sell", "QTY", "DIFF", "Net MUMD Amt",
  "User ID", "Date Posted", "Trans Time", "Invoice Nbr",
];

// Best-guess API field names. SW logs row0 keys on first successful fetch
// so these can be verified and corrected if any column comes back blank.
const FIELD_MAP = {
  "Dept":              ["dept", "accountingDepartmentNumber", "deptNbr", "departmentNbr"],
  "Event Description": ["eventDescription", "eventDesc"],
  "UPC Nbr":           ["upcNbr", "upc", "upcNumber"],
  "Item Nbr":          ["itemNbr", "itemNumber", "itemNo"],
  "Item Description":  ["itemDescription", "itemDesc"],
  "Old Sell":          ["oldSell", "oldSellPrice", "oldPrice"],
  "New Sell":          ["newSell", "newSellPrice", "newPrice"],
  "QTY":               ["qty", "quantity"],
  "DIFF":              ["diff", "diffAmt", "diffAmount"],
  "Net MUMD Amt":      ["netMumdAmt", "netMumdAmount", "netAmount"],
  "User ID":           ["userId", "userID", "userid"],
  "Date Posted":       ["datePosted", "postDate"],
  "Trans Time":        ["transTime", "transactionTime", "transactionTimestamp"],
  "Invoice Nbr":       ["invoiceNbr", "invoiceNumber", "invoiceNo"],
};

function _pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] != null) return String(row[key]);
  }
  return "";
}

let _row0KeysLogged = false;

// ── Tab management ─────────────────────────────────────────────────────────

let _mumdTabId      = null;
let _mumdTabInFlight = null;

async function _ensureMumdTab() {
  // Re-use a known good tab.
  if (_mumdTabId != null) {
    const t = await chrome.tabs.get(_mumdTabId).catch(() => null);
    if (t && t.url?.includes(MUMD_HOST) && !_isLoginUrl(t.url)) return _mumdTabId;
    _mumdTabId = null;
  }

  if (_mumdTabInFlight) return _mumdTabInFlight;

  _mumdTabInFlight = (async () => {
    // Prefer an already-open tab on this domain that's past the login page.
    const tabs = await chrome.tabs.query({ url: `https://${MUMD_HOST}/*` });
    const readyTab = tabs.find(t => _isOnMumdDomain(t.url) && !_isLoginUrl(t.url));
    if (readyTab) {
      _mumdTabId = readyTab.id;
      return _mumdTabId;
    }

    // Open a new background tab and wait for it to finish loading.
    const tab = await chrome.tabs.create({ url: MUMD_URL, active: false });
    console.log("[assocpurchases] MUMD: opened background tab", tab.id);

    await _waitAndHandleAuth(tab.id, 25_000);
    _mumdTabId = tab.id;
    return _mumdTabId;
  })().finally(() => { _mumdTabInFlight = null; });

  return _mumdTabInFlight;
}

function _isLoginUrl(url) {
  return /\/(logon|login|sso|auth)\b/i.test(url ?? "");
}

// Returns true only when the tab is confirmed on the MUMD domain and loaded.
function _isOnMumdDomain(url) {
  return (url ?? "").includes(MUMD_HOST);
}

async function _waitForLoad(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Wait for tab to finish all SSO redirects and land back on sf-reports-ui.walmart.com.
// Clicks the SSO button whenever the tab is on an auth page.
async function _waitAndHandleAuth(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  await _waitForLoad(tabId, 15_000);

  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;

    if (_isOnMumdDomain(t.url) && t.status === "complete") {
      // Give the React app time to initialise window.__SSO_CTX__.
      await new Promise(r => setTimeout(r, 2_500));
      return;
    }

    if (t.status === "complete") {
      // Completed on an auth/redirect page — click SSO and wait again.
      console.log("[assocpurchases] MUMD: SSO redirect at", t.url, "— clicking SSO");
      await _auth.clickSso(tabId, SSO_SELECTORS).catch(() => {});
      await _waitForLoad(tabId, Math.min(deadline - Date.now(), 12_000));
    } else {
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

// ── MAIN-world fetch function (serialised into the MUMD tab) ───────────────

// IMPORTANT: this function is serialised and executed inside the page —
// it must be PURE (no closures over outer variables). Args are passed via
// the `args` parameter of executeScript.
async function _mumdApiFetch(apiUrl, body) {
  const getCookie = name => {
    const c = document.cookie.split("; ").find(r => r.startsWith(name + "="));
    return c ? decodeURIComponent(c.split("=")[1]) : "";
  };

  // SSO_CRED cookie  → sso-pingfed-access  (PingFed session credential)
  // __SSO_CTX__.userinfo → sso-pingfed-userinfo (set by React app after init)
  const ssoAccess   = getCookie("SSO_CRED");
  const ssoUserinfo = window.__SSO_CTX__?.userinfo || "";
  const xsrf        = getCookie("XSRF-TOKEN");

  if (!ssoAccess)   return { __err: "SSO_CRED cookie missing", __status: 401 };
  // React app hasn't populated __SSO_CTX__ yet — caller should retry after settling
  if (!ssoUserinfo) return { __err: "SSO_CTX not ready", __needsRetry: true };

  try {
    const r = await fetch(apiUrl, {
      method:      "POST",
      credentials: "include",
      headers: {
        "content-type":         "application/json",
        "accept":               "application/json, text/plain, */*",
        "referer":              "https://sf-reports-ui.walmart.com/",
        "wm_svc.env":           "prod",
        "wm_svc.name":          "SF-REPORTS-NG-SF-REPORTS-NG",
        "x-canary-store":       "false",
        "x-xsrf-token":         xsrf,
        "sso-pingfed-access":   ssoAccess,
        "sso-pingfed-userinfo": ssoUserinfo,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { __err: `HTTP ${r.status}`, __status: r.status };
    return await r.json();
  } catch (e) {
    return { __err: e?.message ?? String(e) };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch MUMD markdown detail rows.
 *
 * @param {string|number} storeNo
 * @param {string} startDate  "YYYY-MM-DD"
 * @param {string} endDate    "YYYY-MM-DD"
 * @returns {{ headers, rows, rowCount, filterText, capturedAt, error? }}
 */
export async function fetchMumdData(storeNo, startDate, endDate) {
  let tabId;
  try {
    tabId = await _ensureMumdTab();
  } catch (e) {
    return {
      headers: DOM_COLUMNS, rows: [], rowCount: 0,
      filterText: [], capturedAt: Date.now(),
      error: `MUMD tab unavailable: ${e?.message ?? e}`,
    };
  }

  // Verify the tab is on the MUMD domain (not stuck on an SSO/redirect page).
  const tabNow = await chrome.tabs.get(tabId).catch(() => null);
  if (!tabNow || !_isOnMumdDomain(tabNow.url)) {
    _mumdTabId = null;
    return {
      headers: DOM_COLUMNS, rows: [], rowCount: 0,
      filterText: [], capturedAt: Date.now(),
      error: "MUMD sign-in required — open sf-reports-ui.walmart.com, complete sign-in, then try again.",
    };
  }

  const _execPage = (apiUrl, body) => chrome.scripting.executeScript({
    target: { tabId },
    world:  "MAIN",
    func:   _mumdApiFetch,
    args:   [apiUrl, body],
  }).then(r => r?.[0]?.result).catch(e => { _mumdTabId = null; throw e; });

  const PAGE_SIZE = 2000;
  let allRaw     = [];
  let pageNo     = 1;
  let totalCount = null;

  // First probe: wait until window.__SSO_CTX__ is ready (React app init).
  const probeUrl  = `${MUMD_API}?pageNo=1&pageSize=1&sortBy=accountingDepartmentNumber&sortingOrder=ASC`;
  const probeBody = { countryCode: "US", startDate, endDate, storeNumbers: [parseInt(storeNo)] };
  const ctxDeadline = Date.now() + 10_000;
  let probeResult;
  while (Date.now() < ctxDeadline) {
    probeResult = await _execPage(probeUrl, probeBody).catch(e => ({ __err: String(e) }));
    if (!probeResult?.__needsRetry) break;
    console.log("[assocpurchases] MUMD: waiting for __SSO_CTX__...");
    await new Promise(r => setTimeout(r, 800));
  }
  if (probeResult?.__needsRetry) {
    return {
      headers: DOM_COLUMNS, rows: [], rowCount: 0,
      filterText: [], capturedAt: Date.now(),
      error: "MUMD session not ready — open sf-reports-ui.walmart.com, wait for it to fully load, then try again.",
    };
  }
  // If probe got a hard auth failure, surface it now instead of running pagination.
  if (probeResult?.__err && (probeResult.__status === 401 || probeResult.__status === 403)) {
    _mumdTabId = null;
    return {
      headers: DOM_COLUMNS, rows: [], rowCount: 0,
      filterText: [], capturedAt: Date.now(),
      error: "MUMD session expired — open sf-reports-ui.walmart.com, sign in, then try again.",
    };
  }

  while (true) {
    const apiUrl = `${MUMD_API}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}&sortBy=accountingDepartmentNumber&sortingOrder=ASC`;
    const body   = { countryCode: "US", startDate, endDate, storeNumbers: [parseInt(storeNo)] };

    let result;
    try {
      result = await _execPage(apiUrl, body);
    } catch (e) {
      return {
        headers: DOM_COLUMNS, rows: [], rowCount: 0,
        filterText: [], capturedAt: Date.now(),
        error: `MUMD executeScript failed: ${e?.message ?? e}`,
      };
    }

    if (result?.__err) {
      if (result.__status === 401 || result.__status === 403) {
        _mumdTabId = null;
        return {
          headers: DOM_COLUMNS, rows: [], rowCount: 0,
          filterText: [], capturedAt: Date.now(),
          error: "MUMD session expired — open sf-reports-ui.walmart.com, sign in, then try again.",
        };
      }
      return {
        headers: DOM_COLUMNS, rows: [], rowCount: 0,
        filterText: [], capturedAt: Date.now(),
        error: `MUMD API error: ${result.__err}`,
      };
    }

    const rawRows = Array.isArray(result) ? result : (result?.data ?? result?.rows ?? []);

    if (!_row0KeysLogged && rawRows.length) {
      _row0KeysLogged = true;
      console.log("[assocpurchases] MUMD row0 keys:", Object.keys(rawRows[0]));
      console.log("[assocpurchases] MUMD row0 sample:", rawRows[0]);
    }

    allRaw.push(...rawRows);

    if (totalCount === null) {
      totalCount = result?.totalCount ?? result?.total ?? result?.totalRows ?? allRaw.length;
    }
    if (allRaw.length >= totalCount || rawRows.length < PAGE_SIZE) break;
    pageNo++;
  }

  const rows = allRaw.map(r => DOM_COLUMNS.map(col => _pickField(r, FIELD_MAP[col] ?? [col])));
  console.log(`[assocpurchases] MUMD fetched ${rows.length} rows — store ${storeNo}, ${startDate}→${endDate}`);

  return {
    headers:    DOM_COLUMNS,
    rows,
    rowCount:   rows.length,
    filterText: [`Store ${storeNo}`, `${startDate} → ${endDate}`],
    capturedAt: Date.now(),
  };
}
