// modules/digitalmetrics/lib/sources/tableau_driver.js
//
// The one way this module reads a Tableau worksheet: open the view in a
// background tab with its filters as URL PARAMETERS, wait for the embedding
// JS API to register a usable viz in the TOP frame, read the worksheet's
// summary data, close the tab.
//
// Shared by tableau_metrics.js (Associate By Day) and tableau_express.js
// (Express Pickup overview). The contract was established live — see
// dev/DIGITALMETRICS_PULL_FINDINGS.md before changing any constant below.
//
// Runs in the service worker.

const VIZ_READY_MS = 180_000;  // cold SSO + first render, with headroom for sharing the browser with another module's capture
const SETTLE_MS    = 12_000;   // longest we wait for rows after the viz registers
const READ_POLL_MS = 750;      // between reads while waiting for rows
const LOAD_MS      = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Open `url` in a background tab, read `worksheetName`'s summary rows, close
 * the tab. Returns `{ columns, rows }` in Tableau's MELTED shape; what the
 * rows mean is the caller's business.
 *
 * `onProgress` gets `{ phase: "opening" | "rendering" | "reading", ...extra }`
 * so the caller can label the pull in the UI.
 *
 * Always closes its tab — including on failure. A failed pull that leaves a
 * background tab behind is how you end up with forty of them.
 */
export async function readWorksheetViaTab(url, worksheetName, { onProgress = () => {}, extra = {} } = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    onProgress({ phase: "opening", ...extra });
    await waitForTabLoad(tab.id, LOAD_MS);
    onProgress({ phase: "rendering", ...extra });
    await waitForViz(tab.id, VIZ_READY_MS);

    onProgress({ phase: "reading", ...extra });
    const out = await readWhenSettled(tab.id, worksheetName);
    if (!out?.ok) throw new Error(out?.reason || "summary read failed");
    return { columns: out.columns, rows: out.rows };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Read the worksheet once its data query has settled.
 *
 * The viz registers before its query returns; reading immediately yields 0
 * rows on a cold session. This used to be a flat 6 s sleep, which every tab
 * paid whether the rows landed in one second or five — and the Express pull
 * opens one tab per day. Now the sheet is polled: the read is accepted as
 * soon as it returns rows AND a second read a moment later agrees on the row
 * count (a guard against catching a query mid-fill).
 *
 * An empty sheet gets a LONGER window than the old sleep before it is
 * believed (12 s vs 6 s). Probing 2026-09-27, a fresh URL-pinned load of a
 * day with 42 Express orders read 0 rows at the old 6 s mark once in four
 * loads. An empty read on a real day is not harmless: pullExpressDay's
 * unfiltered check then finds the store-day and records it as ZERO orders,
 * permanently for anything older than the volatile window. Quiet days are
 * rare, so the extra wait costs almost nothing in practice.
 */
async function readWhenSettled(tabId, worksheetName) {
  const readOnce = async () => (await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: readSummaryInPage,
    args: [worksheetName],
  }))?.[0]?.result;

  const deadline = Date.now() + SETTLE_MS;
  let last = null;
  let lastCount = -1;
  while (Date.now() < deadline) {
    const out = await readOnce();
    const count = out?.ok ? out.rows.length : -1;
    if (count > 0 && count === lastCount) return out;
    last = out;
    lastCount = count;
    await sleep(READ_POLL_MS);
  }
  // Window exhausted: take the most recent full read (an honest empty, or a
  // row count that was still moving — the latter has never been observed).
  return last?.ok ? last : await readOnce();
}
