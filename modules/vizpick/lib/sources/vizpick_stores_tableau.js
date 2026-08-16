// modules/vizpick/lib/sources/vizpick_stores_tableau.js
//
// Store-level VizPick capture via the Tableau *crosstab CSV export* — same
// mechanism market120 uses for its ClearanceDeleted "CD Store" sheet
// (lib/sources/clearance_stores_tableau.js), pointed at the VizPick
// workbook's "Download Summary by Store" sheet instead.
//
// Flow:
//   1. Find/open the VizPick tab.
//   2. Wait for the viz toolbar (Download button) to exist = data rendered.
//   3. Click Download → Crosstab → select the "Download Summary by Store"
//      sheet thumbnail (index 2, confirmed live 2026-08-16) → CSV → Export.
//   4. The content-script fetch-ring captures the CSV response body.
//   5. Parse it with parseVizpickStoresCsv (all markets — market filtering
//      happens in the UI, not the capture) and return rows.
//
// Read-only: export ≠ mutation (a crosstab download is a GET/POST that
// renders existing data).

import { parseVizpickStoresCsv, parseGrandTotal } from "../parse_vizpick_stores_csv.js";

const REPORT_URL  = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPick?:iid=1&:linktarget=_self";
const TAB_PATTERN = "https://stores.tableau.wal-mart.com/*VizPick*";

const LOAD_TIMEOUT_MS   = 30_000;
const VIZ_READY_WAIT_MS = 60_000;   // Tableau initial render can be slow, even foregrounded
const EXPORT_WAIT_MS    = 45_000;
const POLL_MS           = 800;
const INSTALL_GRACE_MS  = 3_000;    // give the document_start script a beat before assuming it's missing

// The "Download Summary by Store" sheet thumbnail index in the crosstab
// dialog — verified live via chrome devtools against the real dialog's
// data-tb-test-id="sheet-thumbnail-N" list on the VizPick workbook.
const STORE_SHEET_INDEX = 2;

// Identifying header the CSV body must contain to be the Summary-by-Store
// export (as opposed to any other sheet's crosstab).
const STORE_CSV_NEEDLE = "Cases Seen %";

export async function fetchVizpickStoresTableau() {
  // Remember what was focused so we can politely restore it afterward.
  const prevActive = await getActiveTab();

  const opened = await findOrOpenReportTab();
  if (!opened) {
    return { ok: false, errorClass: "TAB", error: "Could not open Tableau VizPick tab." };
  }
  const { tab, didOpen } = opened;

  // Tableau renders its viz almost entirely through requestAnimationFrame,
  // which Chrome throttles hard in background tabs. Foreground the capture
  // tab so it renders at full speed; we restore the user's previous tab in
  // the finally block.
  await focusTab(tab.id).catch(() => {});

  // Only close the tab we opened when the capture actually SUCCEEDS. On any
  // failure (session/SSO, render timeout, export UI), leave it open so the
  // user can see what happened and re-auth if needed.
  let succeeded = false;

  try {
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);

    if (!(await waitForCaptureInstalled(tab.id, INSTALL_GRACE_MS))) {
      await chrome.tabs.reload(tab.id, { bypassCache: false });
      await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
      await waitForCaptureInstalled(tab.id, INSTALL_GRACE_MS);
    }

    const ready = await waitForVizReady(tab.id, VIZ_READY_WAIT_MS);
    if (!ready) {
      return {
        ok: false,
        errorClass: "SESSION",
        error: "Tableau viz did not render in time (session may need SSO re-auth or a store filter). " +
               "The tab was left open — confirm data renders there, then Refresh again.",
        keptTabOpen: true,
      };
    }

    // Clear the ring so we only match the CSV from *this* export, not a stale one.
    await clearRing(tab.id);

    const triggered = await triggerCrosstabExport(tab.id, STORE_SHEET_INDEX);
    if (!triggered.ok) {
      return { ok: false, errorClass: "EXPORT_UI", error: `Could not drive crosstab export: ${triggered.reason}`, debug: triggered, keptTabOpen: true };
    }

    const csv = await pollForCsv(tab.id, EXPORT_WAIT_MS, POLL_MS);
    if (!csv) {
      const ring = await dumpRingSummary(tab.id);
      return {
        ok: false,
        errorClass: "NO_CAPTURE",
        error: `No CSV containing "${STORE_CSV_NEEDLE}" captured within ${EXPORT_WAIT_MS}ms.`,
        debug: ring,
        keptTabOpen: true,
      };
    }

    const parsed = parseVizpickStoresCsv(csv.respBody);
    if (!parsed.ok) {
      return {
        ok: false,
        errorClass: "PARSE",
        error: `Store CSV parse failed: ${parsed.reason}`,
        debug: { capturedUrl: csv.url, bodyPreview: (csv.respBody || "").slice(0, 2048) },
      };
    }

    // Grand Total row rides along in the same crosstab; used for context.
    const gt = parseGrandTotal(csv.respBody);

    succeeded = true;
    return {
      ok: true,
      rows: parsed.rows,
      grandTotal: gt.ok ? gt.national : null,
      capturedAt: new Date().toISOString(),
      debug: { capturedUrl: csv.url, storeCount: parsed.rows.length, hasGrandTotal: gt.ok },
    };
  } finally {
    // Close the tab only if we opened it AND the capture succeeded. Leaving
    // a failed tab open lets the user re-auth / inspect. Restore focus to
    // the tab the user was on before we hijacked the foreground.
    if (didOpen && succeeded) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    if (prevActive?.id && prevActive.id !== tab.id) {
      focusTab(prevActive.id).catch(() => {});
    }
  }
}

// ── Tab management (same lifecycle as market120's clearance_stores_tableau.js) ──
async function findOrOpenReportTab() {
  const existing = await chrome.tabs.query({ url: TAB_PATTERN });
  if (existing.length) return { tab: existing[0], didOpen: false };
  // Open ACTIVE: Tableau's rAF-driven render is throttled in background tabs.
  // We restore the user's previous tab afterward.
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: true });
  return tab ? { tab, didOpen: true } : null;
}

async function getActiveTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t || null;
  } catch { return null; }
}

async function focusTab(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return;
  if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

async function waitForCaptureInstalled(tabId, graceMs) {
  const deadline = Date.now() + graceMs;
  do {
    if (await isCaptureInstalled(tabId)) return true;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return false;
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function isCaptureInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => !!window.__APAISUITE_VIZPICK_TABLEAU_CAP,
    });
    return (results || []).some((r) => r?.result === true);
  } catch { return false; }
}

// Poll until the viz toolbar Download button exists (in any frame) = the
// viz has rendered actual data (not just the shell / error dialog).
async function waitForVizReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evalInVizFrame(tabId, VIZ_READY_FN);
    if (ok === true) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

async function clearRing(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => { window.__APAISUITE_VIZPICK_TABLEAU_CAP?.clear?.(); },
    });
  } catch {}
}

// Drive the crosstab export dialog. Runs entirely inside the viz frame's
// MAIN world with realistic pointer events (Tableau ignores synthetic
// .click() on its toolbar). Returns {ok, reason?}.
async function triggerCrosstabExport(tabId, sheetIndex) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world:  "MAIN",
    args:   [sheetIndex],
    func:   exportDriverFn,
  });
  for (const r of (results || [])) {
    if (r?.result && r.result.ran) return r.result;
  }
  return { ok: false, reason: "viz frame with toolbar not found" };
}

async function pollForCsv(tabId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await findCsvInRing(tabId);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function findCsvInRing(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [STORE_CSV_NEEDLE],
      func:   (needle) => window.__APAISUITE_VIZPICK_TABLEAU_CAP?.findBlobBySubstr?.(needle) || null,
    });
    for (const r of (results || [])) if (r?.result) return r.result;
    return null;
  } catch { return null; }
}

async function dumpRingSummary(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => {
        const cap = window.__APAISUITE_VIZPICK_TABLEAU_CAP;
        if (!cap) return { installed: false, url: location.href };
        const all = cap.all();
        return { installed: true, url: location.href, size: all.length, urls: all.slice(-12).map((e) => `${e.method} ${e.url} → ${e.status}`) };
      },
    });
    return { byFrame: (results || []).map((r) => r?.result).filter(Boolean) };
  } catch { return null; }
}

async function evalInVizFrame(tabId, fn, ...args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: "MAIN", args, func: fn,
    });
    for (const r of (results || [])) if (r?.result === true) return true;
    return false;
  } catch { return false; }
}

// ── Injected page functions (serialized to the tab; keep self-contained) ──

function VIZ_READY_FN() {
  return !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]');
}

// Full export driver injected into the viz frame. Clicks
// Download → Crosstab → select sheet → CSV radio → Export, using realistic
// pointer event sequences. Returns { ran, ok, reason, steps }.
function exportDriverFn(sheetIndex) {
  const steps = {};
  const rc = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","focus","pointerup","mouseup","click"]) {
      const E = t.startsWith("pointer") ? PointerEvent : (t === "focus" ? FocusEvent : MouseEvent);
      try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
    }
    return true;
  };
  const tid = (t) => document.querySelector(`[data-tb-test-id="${t}"]`);

  const dl = tid("viz-viewer-toolbar-button-download");
  if (!dl) return { ran: false, ok: false, reason: "no toolbar in this frame" };

  // Tableau's flyout + dialog open asynchronously and each stage can lag on
  // a cold viz. Run a self-scheduling state machine that advances only when
  // the next element actually exists, retrying every 400ms for up to ~24s.
  const stages = [
    { name: "download",  find: () => tid("viz-viewer-toolbar-button-download") },
    { name: "crosstab",  find: () => tid("download-flyout-download-crosstab-MenuItem") },
    { name: "sheet",     find: () => tid(`sheet-thumbnail-${sheetIndex}`), pick: (el) => el.querySelector("img,[role=button],button,div") || el },
    { name: "csv",       find: () => tid("crosstab-options-dialog-radio-csv-RadioButton"), pick: (el) => el.querySelector("input") || el },
    { name: "export",    find: () => tid("export-crosstab-export-Button"), ready: (el) => !el.disabled },
  ];

  let i = 0;
  let ticks = 0;
  const MAX_TICKS = 60; // 60 * 400ms = 24s
  steps.reached = {};

  const advance = () => {
    if (i >= stages.length) return;
    if (ticks++ > MAX_TICKS) return;
    const st = stages[i];
    const el = st.find();
    if (el && (!st.ready || st.ready(el))) {
      rc(st.pick ? st.pick(el) : el);
      steps.reached[st.name] = true;
      i++;
    }
    if (i < stages.length) setTimeout(advance, 400);
  };
  advance();

  return { ran: true, ok: true, steps };
}
