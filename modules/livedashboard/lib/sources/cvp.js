// modules/livedashboard/lib/sources/cvp.js
//
// Hoops CVP per-store fetch. Endpoint discovered in
// dev/HOOPS_PERSTORE_FINDINGS.md.
//
// Usage:
//   import { fetchCvp } from "./lib/sources/cvp.js";
//   const cvp = await fetchCvp("1458");
//   // cvp = { rows: [{ wmWeekText, sellThruPctTy, ... }], currentWeek: {...} }
//
// Returns 13 weeks of trailing per-week data in one call. Same-origin
// session cookies carry automatically when host_permissions covers
// *.wal-mart.com (already present in top-level manifest).

import { registerSessionTab } from "../../../../shared/tabSessions.js";

const ENDPOINT = "https://hoops.wal-mart.com/ops-portal/v1/trpc/metric.cvp.megaCard.CVPOverview";
// Direct ops-portal URL — bypasses the soteria/login redirect for users
// without a session, but lands authenticated users straight on the app.
const HOOPS_OPS_PORTAL_URL = "https://hoops.wal-mart.com/ops-portal/";
// MATCH: only ops-portal tabs. Excludes /soteria/login (logged-out
// interstitial) and /api/* (no UI). Authenticated tabs end up here.
const HOOPS_TAB_PATTERN = "https://hoops.wal-mart.com/ops-portal/*";
// Indicator of a logged-out tab we should NOT try to fetch from.
const HOOPS_LOGGED_OUT_URL_RE = /hoops\.wal-mart\.com\/(soteria|login)/i;

// timeType=202 = trailing weeks (per probe). depts/sbuIds [-9999,-9999]
// = "all merch" headline (per probe). buType=6 = store-level.
const DEFAULT_PARAMS = {
  buType:   6,
  timeType: 202,
  depts:    [-9999],
  sbuIds:   [-9999],
};

// Per-category filter combinations. Derived from utils.dept.sbuIdDepts in
// dev/hoops-perstore-probe.json:
//   sbu=1 → Food (Service Deli, Bakery, Meat, Produce, etc. — incl. all
//           Fresh subdepts)
//   sbu=3 → General Merchandise (Toys, Sporting Goods, Electronics, etc.)
// Fresh is the subset of Food where isFreshDeptInd=true. The page itself
// fires depts:[80,81,93,94,97,98] for the Fresh view — we mirror that.
//
// Note: "Food" here INCLUDES Fresh (it's a superset). The dashboard shows
// both metrics so you can compare Fresh-only sell-through to overall Food.
export const CVP_CATEGORIES = [
  { id: "headline", label: "Headline",   filters: { depts: [-9999],                    sbuIds: [-9999] } },
  { id: "fresh",    label: "Fresh",      filters: { depts: [80, 81, 93, 94, 97, 98],   sbuIds: [] } },
  { id: "food",     label: "Food",       filters: { depts: [],                          sbuIds: [1] } },
  { id: "gm",       label: "GM",         filters: { depts: [],                          sbuIds: [3] } },
];

export async function fetchCvp(storeNbr, opts = {}) {
  const buId = Number(storeNbr);
  if (!Number.isFinite(buId)) throw new Error(`cvp: storeNbr must be numeric, got ${storeNbr}`);

  const input = encodeURIComponent(JSON.stringify({
    json: { ...DEFAULT_PARAMS, buId, ...opts },
  }));
  const url = `${ENDPOINT}?input=${input}`;

  // First try: direct fetch from SW with credentials. Works when the
  // hoops SSO cookies carry to chrome-extension origin (uncommon in
  // practice — Walmart's session cookies are scoped Strict).
  let json = await tryDirectFetch(url);
  if (json && !json.__authFail) return finalizeFetch(json);

  // Fallback: replay the GET from inside a hoops.wal-mart.com tab so
  // the SAML session cookies attach naturally. Opens a background tab
  // if one isn't already open. Returns AUTH error when even the tab
  // can't authenticate (user must sign into Hoops once in a real tab).
  const tabResult = await tryFetchInsideHoopsTab(url);
  if (!tabResult.ok) return tabResult;   // AUTH / TAB / HTTP error already shaped
  return finalizeFetch(tabResult.json);
}

async function tryDirectFetch(url) {
  try {
    const resp = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json" },
    });
    if (resp.status === 401 || resp.status === 403) return { __authFail: true };
    if (!resp.ok) return { __authFail: true };
    return await resp.json();
  } catch {
    return { __authFail: true };
  }
}

async function tryFetchInsideHoopsTab(url) {
  // Prefer an authenticated ops-portal tab. Skip soteria/login tabs —
  // they're in the logged-out interstitial state and any fetch from
  // them returns 401. We can only carry real auth from a tab that's
  // landed on the post-SSO destination.
  let tabs = await chrome.tabs.query({ url: HOOPS_TAB_PATTERN });
  tabs = tabs.filter((t) => !HOOPS_LOGGED_OUT_URL_RE.test(t.url || ""));
  if (!tabs.length) {
    // NOTE: this tab is intentionally LEFT OPEN after a successful pull —
    // it serves as the authenticated session host for subsequent dashboard
    // refreshes (alarm-driven, every few minutes). Closing on success would
    // force a SAML round-trip on every poll. The Pass-2 sessionManager will
    // own tab-lifecycle (close idle tabs we opened after N minutes); for
    // now we accept one persistent background hoops tab per session.
    // See docs/AUTH_AUDIT.md::Recommendation.
    let openedTab;
    try { openedTab = await chrome.tabs.create({ url: HOOPS_OPS_PORTAL_URL, active: false }); }
    catch (e) { return { ok: false, errorClass: "TAB", error: `Could not open hoops tab: ${e?.message ?? e}` }; }
    // Ours, and kept alive on purpose — but now on the reaper's clock rather
    // than forever. See shared/tabSessions.js.
    await registerSessionTab("livedashboard", openedTab.id);
    // Wait for the tab to land on ops-portal (after any SAML round-trip).
    const tab = await waitForOpsPortalTab(25_000);
    if (!tab) return { ok: false, errorClass: "AUTH", error: "Hoops session not active. Open hoops.wal-mart.com/ops-portal/ in a tab, sign in, then click Refresh." };
    tabs = [tab];
  }
  const tab = tabs[0];
  await waitForTabLoad(tab.id, 15_000);

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  "MAIN",
      args:   [url],
      func:   async (u) => {
        try {
          const r = await fetch(u, { method: "GET", credentials: "include", headers: { "Accept": "application/json" } });
          if (r.status === 401 || r.status === 403) return { __auth: true, status: r.status };
          const text = await r.text();
          return { __auth: false, status: r.status, body: text };
        } catch (e) {
          return { __auth: false, status: 0, error: String(e?.message ?? e) };
        }
      },
    });
  } catch (e) {
    return { ok: false, errorClass: "AUTH", error: "Hoops tab not authenticated. Open hoops.wal-mart.com/ops-portal/ manually and sign in." };
  }
  const out = results?.[0]?.result;
  if (!out)          return { ok: false, errorClass: "EMPTY", error: "executeScript returned no result." };
  if (out.__auth)    return { ok: false, errorClass: "AUTH", error: "Hoops session expired. Open hoops.wal-mart.com/ops-portal/ in a tab, sign in, then click Refresh." };
  if (!out.body)     return { ok: false, errorClass: "EMPTY", error: out.error || `Hoops returned status ${out.status} with no body` };
  try {
    return { ok: true, json: JSON.parse(out.body) };
  } catch {
    return { ok: false, errorClass: "PARSE", error: "Hoops returned non-JSON body." };
  }
}

async function waitForOpsPortalTab(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = (await chrome.tabs.query({ url: HOOPS_TAB_PATTERN }))
      .filter((t) => !HOOPS_LOGGED_OUT_URL_RE.test(t.url || ""));
    if (tabs.length) {
      const t = tabs[0];
      if (t.status === "complete") return t;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
async function waitForTabLoad(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

function finalizeFetch(json) {
  const decoded = decodeOverview(json);
  if (!decoded.rows.length) {
    return { ok: false, errorClass: "EMPTY", error: "Hoops returned no rows for this store." };
  }
  const current = decoded.rows.find((r) => r.timeOffset === 0)
                 ?? decoded.rows.slice().sort((a, b) => b.timeInt - a.timeInt)[0];
  return { ok: true, rows: decoded.rows, currentWeek: current, capturedAt: new Date().toISOString() };
}

// Pull all four CVP variants (headline + Fresh + Food + GM) in parallel.
// Returns { ok, byCategory: { headline, fresh, food, gm }, capturedAt }.
// Each per-category entry has { ok, rows, currentWeek } on success or
// { ok:false, errorClass, error } on failure. The overall result is ok
// when at least the headline pull succeeded.
export async function fetchCvpBreakdown(storeNbr) {
  const results = await Promise.all(
    CVP_CATEGORIES.map(async (cat) => {
      const r = await fetchCvp(storeNbr, cat.filters);
      return { id: cat.id, label: cat.label, ...r };
    })
  );
  const byCategory = Object.fromEntries(results.map((r) => [r.id, r]));
  const headlineOk = byCategory.headline?.ok === true;
  return {
    ok:          headlineOk,
    byCategory,
    capturedAt:  new Date().toISOString(),
    error:       headlineOk ? null : (byCategory.headline?.error ?? "headline pull failed"),
    errorClass:  headlineOk ? null : (byCategory.headline?.errorClass ?? "UNKNOWN"),
  };
}

function decodeOverview(resp) {
  const cols = resp?.result?.data?.json?.meta?.columns;
  const rows = resp?.result?.data?.json?.rows;
  if (!Array.isArray(cols) || !Array.isArray(rows)) {
    return { rows: [] };
  }
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  // Defensive: every column the dashboard references must exist.
  const required = ["buId", "timeOffset", "timeInt", "timeTextShort",
                    "cvpSellThruPct_Ty454", "cvpSellThruPct_Ly454",
                    "cvpTotalQty_Ty454", "cvpSalesQty_Ty454"];
  for (const c of required) {
    if (!(c in idx)) return { rows: [] };
  }
  return {
    rows: rows.map((row) => ({
      storeNbr:           String(row[idx.buId]),
      timeOffset:         row[idx.timeOffset],
      timeInt:            row[idx.timeInt],
      wmWeekText:         row[idx.timeTextShort],
      wmWeekTextLong:     row[idx.timeTextLong] ?? null,
      sellThruPctTy:      row[idx.cvpSellThruPct_Ty454],
      sellThruPctLy:      row[idx.cvpSellThruPct_Ly454],
      adherencePctTy:     row[idx.cvpAdherencePct_Ty454] ?? null,
      adherencePctLy:     row[idx.cvpAdherencePct_Ly454] ?? null,
      compliancePctTy:    row[idx.cvpCompliancePct_Ty454] ?? null,
      compliancePctLy:    row[idx.cvpCompliancePct_Ly454] ?? null,
      cvpTotalQtyTy:      row[idx.cvpTotalQty_Ty454],
      cvpTotalQtyLy:      row[idx.cvpTotalQty_Ly454] ?? null,
      cvpSalesQtyTy:      row[idx.cvpSalesQty_Ty454],
      cvpSalesQtyLy:      row[idx.cvpSalesQty_Ly454] ?? null,
      cvpSalesRetailTy:   row[idx.cvpSalesRetailAmt_Ty454] ?? null,
      cvpSalesRetailLy:   row[idx.cvpSalesRetailAmt_Ly454] ?? null,
    })),
  };
}

// Severity bands for the dashboard widget. See dev/HOOPS_PERSTORE_FINDINGS.md
// — these are scaled to the tRPC cvpSellThruPct_Ty454 metric, NOT the
// GraphQL-derived ratio used in claimsdisposition.
export function severityForSellThru(pct) {
  if (pct == null || Number.isNaN(pct)) return "unknown";
  if (pct >= 55) return "ok";
  if (pct >= 45) return "warn";
  return "fail";
}
