// modules/digitalmetrics/lib/sources/tableau_metrics.js
//
// Automated pull of the "Associate By Day" data from the Store Fulfillment
// Scorecard. Runs in the service worker.
//
// The contract here was established live — see
// dev/DIGITALMETRICS_PULL_FINDINGS.md, which is the file to read before
// changing any constant below.
//
// Shape of one pull:
//   1. open the view in a background tab, with the filters as URL PARAMETERS
//   2. wait for window.tableau.VizManager to register a viz (TOP frame)
//   3. getSummaryDataAsync on the "Associate By Day" worksheet
//   4. pivot (lib/data/tableau.js) → split by store+week (lib/data/parse.js)
//
// Why URL parameters and not applyFilterAsync: the view's filters are a
// DEPENDENT CASCADE ("Select Pick Date First", "Select Store Number(s)
// Second"). Until a date is set, `Store #` has an empty domain and
// applyFilterAsync throws an error whose entire message is the rejected value.
// URL parameters are applied server-side before the view renders, so the
// cascade never has to be satisfied client-side. Measured: 3 dates for one
// store = 4,064 rows in a single page load.

const VIEW_BASE =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance";

// Field names, NOT the captions shown on the controls. The captions
// ("Select Pick Date First") are not accepted as URL keys.
const FILTER_DATE  = "Pick Date";
const FILTER_STORE = "Store #";

// Trailing space is real — the worksheet is named "Associate By Day ". Always
// compare trimmed.
const WORKSHEET = "Associate By Day";

const VIZ_READY_MS = 120_000;  // cold SSO + first render
const SETTLE_MS    = 6_000;    // after the viz registers, before reading
const LOAD_MS      = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the scoped view URL. Dates are ISO and comma-separated. */
export function buildViewUrl(store, isoDates) {
  const dates = (Array.isArray(isoDates) ? isoDates : [isoDates]).filter(Boolean);
  const qs =
    `${encodeURIComponent(FILTER_DATE)}=${dates.map(encodeURIComponent).join(",")}` +
    `&${encodeURIComponent(FILTER_STORE)}=${encodeURIComponent(store)}`;
  return `${VIEW_BASE}?:iid=1&:linktarget=_self&${qs}`;
}

/**
 * Read the worksheet through the Tableau embedding JS API.
 *
 * MUST run in the MAIN world of the TOP frame. The viz iframe also exposes a
 * `window.tableau`, but it is a different object with no VizManager — pointing
 * this at all frames finds the useless one roughly half the time.
 *
 * Pure by construction: no closure over module scope, because it is serialised
 * into the page (MODULE_CONTRACT §4).
 */
async function readSummaryInPage(worksheetName) {
  try {
    const vizzes = window.tableau?.VizManager?.getVizs?.() || [];
    if (!vizzes.length) return { ok: false, reason: "no viz registered" };

    const active = vizzes[0].getWorkbook().getActiveSheet();
    const sheets = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
    const norm = (s) => String(s || "").trim().toLowerCase();
    const ws = sheets.find((s) => norm(s.getName?.()) === norm(worksheetName))
            || sheets.find((s) => norm(s.getName?.()).includes(norm(worksheetName)));
    if (!ws) {
      return { ok: false, reason: `worksheet "${worksheetName}" not found`,
               available: sheets.map((s) => s.getName?.()) };
    }

    // ── await, NOT .then().catch() ──────────────────────────────────────
    // This server serves the Tableau JS API **v1**, whose async methods return
    // its own promise implementation: it has .then(onOk, onErr) and
    // .otherwise(), but NO .catch. Chaining .catch threw
    // "ws.getSummaryDataAsync(...).then(...).catch is not a function" and lost
    // every row. `await` works because it only needs a thenable.
    const data = await ws.getSummaryDataAsync({ maxRows: 0, ignoreSelection: true });
    const cols = data.getColumns().map((c) => c.getFieldName());
    const rows = data.getData().map((row) => {
      const o = {};
      row.forEach((cell, i) => { o[cols[i]] = cell.formattedValue ?? cell.value; });
      return o;
    });
    return { ok: true, columns: cols, rows };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * Is the viz actually USABLE — not merely present?
 *
 * `getVizs().length > 0` is not enough. The viz registers with VizManager
 * before its workbook finishes loading, and reading it in that window throws
 * "Cannot read properties of null (reading 'get_sheet')" from inside Tableau.
 * Interactively the settle delay hid this; a throttled BACKGROUND tab is slow
 * enough that it did not, which is exactly where this driver runs.
 *
 * So probe the thing the caller will actually do: resolve a worksheet.
 */
function vizReadyInPage() {
  try {
    const vizzes = window.tableau?.VizManager?.getVizs?.() || [];
    if (!vizzes.length) return false;
    const wb = vizzes[0].getWorkbook?.();
    if (!wb) return false;
    const active = wb.getActiveSheet?.();
    if (!active) return false;
    const sheets = active.getSheetType?.() === "dashboard" ? active.getWorksheets?.() : [active];
    return Array.isArray(sheets) && sheets.length > 0;
  } catch {
    // Mid-load Tableau throws rather than returning null; that is a "not yet",
    // not a failure.
    return false;
  }
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the pull tab was closed");
    if (tab.status === "complete") return;
    await sleep(500);
  }
}

async function waitForViz(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },   // TOP frame — see readSummaryInPage
      world: "MAIN",
      func: vizReadyInPage,
    }).catch((e) => { last = String(e?.message ?? e); return null; });
    if (res?.[0]?.result) return true;
    await sleep(1000);
  }
  throw new Error(`the viz never rendered within ${Math.round(timeoutMs / 1000)}s` +
                  (last ? ` (last injection error: ${last})` : "") +
                  ". If Tableau is showing an SSO page, sign in once and retry.");
}

/**
 * Pull one (store, dates) slice. Returns the RAW melted rows; pivoting and
 * splitting are the caller's job so this stays a transport concern.
 *
 * Always closes its tab — including on failure. A failed pull that leaves a
 * background tab behind is how you end up with forty of them.
 */
export async function pullMetrics(store, isoDates, { onProgress = () => {} } = {}) {
  if (!store) throw new Error("pullMetrics: no store");
  const dates = (Array.isArray(isoDates) ? isoDates : [isoDates]).filter(Boolean);
  if (!dates.length) throw new Error("pullMetrics: no dates");

  const url = buildViewUrl(store, dates);
  onProgress({ phase: "opening", store, dates: dates.length });

  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabLoad(tab.id, LOAD_MS);
    onProgress({ phase: "rendering", store });
    await waitForViz(tab.id, VIZ_READY_MS);

    // The viz registers before its data query settles; reading immediately
    // yields 0 rows on a cold session.
    await sleep(SETTLE_MS);

    onProgress({ phase: "reading", store });
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: readSummaryInPage,
      args: [WORKSHEET],
    });
    const out = res?.[0]?.result;
    if (!out?.ok) throw new Error(out?.reason || "summary read failed");

    if (!out.rows.length) {
      // Almost always an unscoped view rather than a broken read — say which.
      throw new Error(
        `the view returned 0 rows for store ${store}. Either that store has no ` +
        `data for these dates, or the filters were not applied.`);
    }

    onProgress({ phase: "done", store, rows: out.rows.length });
    return { ok: true, store, dates, columns: out.columns, rows: out.rows };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
