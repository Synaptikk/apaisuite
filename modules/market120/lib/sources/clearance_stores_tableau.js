// modules/market120/lib/sources/clearance_stores_tableau.js
//
// Store-level Clearance/Deleted capture from the Tableau ClearanceDeleted
// dashboard's "CD Store" worksheet.
//
// Reads the sheet through the live vizql session's summary-data command
// (api-get-worksheet-summary-logical-table-data) — the same values the
// crosstab export yields, but with no dialog and no rendering. That means the
// tab can stay in the BACKGROUND: the old Download → Crosstab driver needed a
// foregrounded tab (rAF throttling) and stole the user's focus. Pattern
// mirrors modules/vizpick/lib/sources/tableau_export_replay.js::directSummaryExport.
//
// The sheet is national and long-format (one tuple per store × measure); we
// keep Market 120 stores and sum every store for the national context.
// Cross-checked live 2026-09-15: all 10 Market 120 stores matched the
// crosstab export to the dollar.
//
// Read-only for data. Before reading, the Store quick filter is reset to all
// values: Tableau saves a signed-in user's last filter state server-side, so
// a leftover store filter would otherwise narrow the "national" sheet.

const REPORT_URL  = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/Backroom/ClearanceDeleted?:iid=1&:linktarget=_self";
const TAB_PATTERN = "https://stores.tableau.wal-mart.com/*Backroom*ClearanceDeleted*";
const MARKET      = "120";
const WORKSHEET   = "CD Store";
const DASHBOARD   = "Clearance Deleted";
// Store quick-filter field + the worksheet that owns it (verified 2026-09-15).
// store_detail_tableau.js prefers the live name from bootstrap, falls back here.
export const STORE_FILTER_FN        = "[sqlproxy.0igq6i01qw912t1gjb5p70hh2dar].[none:store_number:ok]";
export const STORE_FILTER_WORKSHEET = "Last Update";

const LOAD_TIMEOUT_MS = 30_000;
const SESSION_WAIT_MS = 90_000;   // SSO bounce + bootstrap; ~3s when signed in
const POLL_MS         = 1_000;
const MIN_NATIONAL_STORES = 500;   // national sheet has ~4,600; fewer = filtered view

// Tableau measure name → StoreRow field (parse_stores_csv.js vocabulary).
const MEASURES = {
  totalUnits:       "Total Clearance Deleted Units",
  totalDollars:     "Total Clearance Deleted $",
  clearanceQty:     "Clearance Quantity",
  clearanceDollars: "Clearance $",
  deletedQty:       "Deleted Quantity",
  deletedDollars:   "Deleted $",
};

export async function fetchClearanceStoresTableau() {
  const opened = await findOrOpenReportTab();
  if (!opened) {
    return { ok: false, errorClass: "TAB", error: "Could not open Tableau ClearanceDeleted tab." };
  }
  const { tab, didOpen } = opened;
  let keepOpen = false;

  try {
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);

    const got = await pollSummary(tab.id, SESSION_WAIT_MS);
    if (!got?.ok) {
      keepOpen = !got;   // no session at all → likely SSO; let the user see it
      return got
        ? { ok: false, errorClass: "SUMMARY", error: `Tableau summary read failed: ${got.reason}`, debug: got }
        : {
            ok: false,
            errorClass: "SESSION",
            error: "Tableau session did not start in time (may need SSO sign-in). " +
                   "The tab was left open in the background — sign in there, then Refresh again.",
            keptTabOpen: true,
          };
    }

    // Tableau keeps a user's last filter state server-side, so a fresh session
    // can open narrowed (seen live 2026-09-15: one store instead of ~4,600).
    // Never let that overwrite the weekly history with a partial market.
    if ((got.nationalStoreCount ?? 0) < MIN_NATIONAL_STORES) {
      return {
        ok: false,
        errorClass: "FILTERED",
        error: `Tableau returned only ${got.nationalStoreCount} store(s) nationally — the ClearanceDeleted view is filtered. ` +
               "Reset its filters (Tableau toolbar → Revert), then Refresh.",
        debug: { tupleCount: got.tupleCount, nationalStoreCount: got.nationalStoreCount },
      };
    }

    const rows = storeRowsFromSummary(got.stores);
    if (!rows.length) {
      return { ok: false, errorClass: "PARSE", error: `No rows for Market ${MARKET} in "${WORKSHEET}".`, debug: { tupleCount: got.tupleCount } };
    }

    return {
      ok: true,
      rows,
      national: nationalFromSummary(got.national),
      capturedAt: new Date().toISOString(),
      debug: { source: `summary:${WORKSHEET}`, storeCount: rows.length, market: MARKET, tupleCount: got.tupleCount, ms: got.ms },
    };
  } finally {
    if (didOpen && !keepOpen) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** Pivot per-store measure maps into StoreRow objects. Pure; exported for tests. */
export function storeRowsFromSummary(stores) {
  return (stores || []).map((s) => {
    const row = { bu: s.bu ?? "", region: s.region ?? "", market: s.market ?? MARKET, store: s.store };
    for (const [field, measure] of Object.entries(MEASURES)) row[field] = Number(s.m?.[measure]) || 0;
    return row;
  });
}

/** National rollup (sum over every store) in parseNationalTotal's shape. */
export function nationalFromSummary(national) {
  if (!national) return null;
  const out = {};
  for (const [field, measure] of Object.entries(MEASURES)) out[field] = Number(national[measure]) || 0;
  return out;
}

// ── Tab management ─────────────────────────────────────────────────
// Always a fresh background tab of our own: an existing ClearanceDeleted tab
// may carry a Store/Market filter (the user's, or a store-detail read), and
// the summary read honours session filters — reusing it would return a
// filtered "national" table.
export async function openReportTab() {
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: false });
  return tab ? { tab, didOpen: true } : null;
}
const findOrOpenReportTab = openReportTab;

export async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

// executeScript never settles on a frozen/discarded tab — without a cap the
// Refresh spinner hangs forever (same failure as the vizpick tab leak).
export function execScript(opts, ms = 45_000) {
  let timer;
  return Promise.race([
    chrome.scripting.executeScript(opts),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`executeScript timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Retry until the viz frame has a vizql session and the summary read answers.
// Returns the summary result, a {ok:false} from a frame that had a session,
// or null when no frame ever had one.
async function pollSummary(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = null;
  while (Date.now() < deadline) {
    try {
      const results = await execScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        args:   [WORKSHEET, DASHBOARD, MARKET, STORE_FILTER_FN, STORE_FILTER_WORKSHEET],
        func:   summaryFn,
      });
      const answered = (results || []).map((r) => r?.result).filter(Boolean);
      const ok = answered.find((r) => r.ok);
      if (ok) return ok;
      if (answered.length) lastFailure = answered[0];
    } catch (e) {
      lastFailure = { ok: false, reason: String(e?.message ?? e) };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return lastFailure;
}

// Injected into every frame (MAIN world); self-contained. Returns null in
// frames without a vizql session.
async function summaryFn(worksheet, dashboard, market, storeFilterFn, storeFilterWs) {
  const c = window.tsConfig;
  if (!c?.sessionid || !c.repositoryUrl || !c.site_root) return null;
  const [wb, view] = String(c.repositoryUrl).split("/");
  const base = `${location.origin}/vizql${c.site_root}/w/${wb}/v/${view}/sessions/${c.sessionid}`;
  const form = new FormData();
  const args = {
    visualIdPresModel: JSON.stringify({ worksheet, dashboard }),
    versionName: "1.0", maxRows: "0", ignoreAliases: "false", ignoreSelection: "true",
  };
  for (const [k, v] of Object.entries(args)) form.append(k, v);
  // Clear a Store filter a previous session left saved. A no-op on an
  // unfiltered view; if it fails, the national store-count guard catches it.
  if (storeFilterFn) {
    const ff = new FormData();
    const fargs = {
      visualIdPresModel: JSON.stringify({ worksheet: storeFilterWs, dashboard }),
      globalFieldName: storeFilterFn, membershipTarget: "filter",
      filterValues: "[]", filterUpdateType: "filter-all",
    };
    for (const [k, v] of Object.entries(fargs)) ff.append(k, v);
    await fetch(`${base}/commands/tabdoc/categorical-filter`, {
      method: "POST", body: ff, credentials: "include", signal: AbortSignal.timeout(15000),
    }).catch(() => {});
  }

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${base}/commands/tabdoc/api-get-worksheet-summary-logical-table-data`, {
      method: "POST", body: form, credentials: "include", signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
  if (!res.ok) return { ok: false, reason: `summary HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  const model = body?.vqlCmdResponse?.cmdResultList?.[0]?.commandReturn?.dataTablePresModel;
  if (!model?.showDataFormattedTable) return { ok: false, reason: "summary returned no table (viz still bootstrapping?)" };
  const table = JSON.parse(model.showDataFormattedTable).table;
  const cols = (table.schema || []).map((name) =>
    model.showDataTableColumnPresModels?.find((col) => col.uniqueName === name)?.fieldCaption || name);
  const at = (n) => cols.indexOf(n);
  const iB = at("BU"), iR = at("Region"), iM = at("Market"), iS = at("Store"), iN = at("Measure Names"), iV = at("Measure Values");
  if ([iM, iS, iN, iV].some((i) => i < 0)) return { ok: false, reason: `unexpected columns: ${cols.join(", ")}` };

  const num = (s) => {
    const t = String(s ?? "").trim();
    const neg = /^\(.*\)$/.test(t);
    const v = Number(t.replace(/[$,()\s]/g, ""));
    return Number.isFinite(v) ? (neg ? -Math.abs(v) : v) : 0;
  };
  const stores = {};
  const national = {};
  const tuples = table.tuples || [];
  const allStores = new Set();
  for (const t of tuples) {
    const measure = t[iN];
    const v = num(t[iV]);
    national[measure] = (national[measure] || 0) + v;
    const s = String(t[iS]).trim();
    allStores.add(s);
    if (String(t[iM]).trim() !== market) continue;
    const entry = stores[s] || (stores[s] = { bu: iB >= 0 ? t[iB] : "", region: iR >= 0 ? t[iR] : "", market, store: s, m: {} });
    entry.m[measure] = v;
  }
  return { ok: true, stores: Object.values(stores), national, nationalStoreCount: allStores.size, tupleCount: tuples.length, ms: Math.round(performance.now() - t0) };
}
