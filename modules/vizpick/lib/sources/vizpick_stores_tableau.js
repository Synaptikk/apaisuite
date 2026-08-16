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

import { parseVizpickStoresCsv, parseGrandTotal, parseLastUpdate } from "../parse_vizpick_stores_csv.js";

const REPORT_URL  = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPick?:iid=1&:linktarget=_self";
// Tableau is a hash-router: the view name lives entirely in the URL FRAGMENT
// ("…/#/site/OnlineGrocery/views/VizPick/VizPick"). chrome.tabs.query match
// patterns are matched against the URL *without* its fragment, so a pattern
// like ".../*VizPick*" matches nothing at all — verified live. Query the host
// and disambiguate the view ourselves.
const TAB_PATTERN  = "https://stores.tableau.wal-mart.com/*";
// Must not also match "…/VizPickDetails", which is a different view with a
// different set of sheets — exporting "Download Summary by Store" from it
// would fail.
const VIEW_FRAGMENT = /\/views\/VizPick\/VizPick(?:$|[?#])/i;

const LOAD_TIMEOUT_MS   = 30_000;
// Tableau's initial render can be slow even foregrounded, and a cold session
// adds an SSO redirect chain before the viz starts at all. 60s was observed
// timing out on a first Refresh after an extension reload; 2 minutes covers a
// cold start without making a genuine failure feel hung (the tab stays open
// and the error now says which kind of failure it was).
const VIZ_READY_WAIT_MS = 120_000;
const EXPORT_WAIT_MS    = 45_000;
const UPDATE_WAIT_MS    = 20_000;   // the tiny "Last update" sheet exports fast
const POLL_MS           = 800;
const INSTALL_GRACE_MS  = 3_000;    // give the document_start script a beat before assuming it's missing

// Sheets are selected by NAME, not by a hardcoded thumbnail index. The
// crosstab dialog lists every worksheet in the workbook alphabetically, so
// an index shifts the moment someone adds a sheet — and the VizPick and
// VizPickDetails views have completely different orderings. Matching on the
// thumbnail's own label is stable across both. Indices below are the values
// observed on 2026-08-16 and are used only as a last-resort fallback.
const STORE_SHEET   = { match: "download summary by store", fallbackIndex: 2 };
const UPDATE_SHEET  = { match: "last update",              fallbackIndex: 4 };

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
      // A bare "did not render in time" is unactionable — it can mean SSO,
      // a slow cold render, a Tableau error dialog, or the tab having been
      // navigated somewhere else entirely. Look at the page and say which.
      const diag = await diagnoseUnrenderedTab(tab.id);
      return {
        ok: false,
        errorClass: diag.errorClass,
        error: diag.message + " The tab was left open — confirm data renders there, then Refresh again.",
        debug: diag,
        keptTabOpen: true,
      };
    }

    // ── Source timestamp first ──────────────────────────────────────────
    // The workbook's own "Last update" sheet is the authoritative refresh
    // stamp. Capture it before the big export so that even a later parse
    // failure still tells the UI how fresh Tableau's data actually is. On
    // this view it is a DATE only ("8/16/2026"); VizPickDetails carries a
    // full timestamp. A miss here is non-fatal — the store data is the
    // point, the stamp is metadata.
    let sourceUpdate = null;
    try {
      await clearRing(tab.id);
      const t = await triggerCrosstabExport(tab.id, UPDATE_SHEET);
      if (t.ok) {
        const luCsv = await pollForCsv(tab.id, UPDATE_WAIT_MS, POLL_MS, "\t");
        if (luCsv) {
          const lu = parseLastUpdate(luCsv.respBody);
          if (lu.ok) sourceUpdate = { raw: lu.raw, iso: lu.iso, hasTime: lu.hasTime };
        }
      }
    } catch { /* metadata only — never fail the run for it */ }

    // Clear the ring so we only match the CSV from *this* export, not a stale one.
    await clearRing(tab.id);

    const triggered = await triggerCrosstabExport(tab.id, STORE_SHEET);
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
      // Tableau's own refresh stamp (null if the Last update sheet couldn't
      // be read). The UI must prefer this over capturedAt — capturedAt is
      // just when *we* looked, not when the data changed.
      sourceUpdate,
      capturedAt: new Date().toISOString(),
      debug: {
        capturedUrl: csv.url,
        storeCount: parsed.rows.length,
        hasGrandTotal: gt.ok,
        sourceUpdate,
        sheetNames: triggered.steps?.sheetNames || null,
        sheetPickedBy: triggered.steps?.sheetPickedBy || null,
      },
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
  const all = await chrome.tabs.query({ url: TAB_PATTERN });
  const existing = all.filter((t) => VIEW_FRAGMENT.test(t.url || ""));
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
async function triggerCrosstabExport(tabId, sheet) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world:  "MAIN",
    args:   [sheet.match, sheet.fallbackIndex],
    func:   exportDriverFn,
  });
  for (const r of (results || [])) {
    if (r?.result && r.result.ran) return r.result;
  }
  return { ok: false, reason: "viz frame with toolbar not found" };
}

async function pollForCsv(tabId, timeoutMs, pollMs, needle = STORE_CSV_NEEDLE) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await findCsvInRing(tabId, needle);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function findCsvInRing(tabId, needle = STORE_CSV_NEEDLE) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [needle],
      func:   (n) => window.__APAISUITE_VIZPICK_TABLEAU_CAP?.findBlobBySubstr?.(n) || null,
    });
    for (const r of (results || [])) if (r?.result) return r.result;
    return null;
  } catch { return null; }
}

// Work out WHY the viz never produced a toolbar, so the UI can tell the user
// what to actually do about it instead of "session may need re-auth".
async function diagnoseUnrenderedTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || "(unknown)";

  let page = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => {
        const txt = (document.body?.innerText || "").slice(0, 4000);
        return {
          url: location.href,
          title: document.title,
          installed: !!window.__APAISUITE_VIZPICK_TABLEAU_CAP,
          hasToolbar: !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
          // Tableau paints a spinner/loading zone while a viz is still coming up.
          loading: !!document.querySelector('[class*="tb-loading" i], [class*="LoadingSpinner" i], [class*="loading-indicator" i]'),
          // SSO / login walls
          hasPasswordField: !!document.querySelector('input[type="password"]'),
          signInish: /sign in|log in|password|authenticat|session (has )?expired|access denied|not authorized/i.test(txt),
          // Tableau's own error surface
          tableauError: /an unexpected error occurred|unable to (load|connect)|no data|permission/i.test(txt),
          testIdCount: document.querySelectorAll("[data-tb-test-id]").length,
          textSample: txt.replace(/\s+/g, " ").slice(0, 400),
        };
      },
    });
    // Prefer whichever frame looks most like the real viz frame.
    const frames = (results || []).map((r) => r?.result).filter(Boolean);
    page = frames.find((f) => f.testIdCount > 0) || frames[0] || null;
  } catch (e) {
    page = { evalError: String(e?.message ?? e) };
  }

  let errorClass = "SESSION";
  let message;
  if (page?.hasPasswordField || page?.signInish) {
    errorClass = "AUTH";
    message = "Tableau is showing a sign-in / SSO page, so no data could be read. Sign in on the opened tab, then Refresh again.";
  } else if (!VIEW_FRAGMENT.test(url) && !VIEW_FRAGMENT.test(page?.url || "")) {
    errorClass = "WRONG_VIEW";
    message = `The Tableau tab is on "${url}", not the VizPick summary view.`;
  } else if (page?.loading || page?.testIdCount > 0) {
    errorClass = "SLOW_RENDER";
    message = `Tableau was still rendering after ${Math.round(VIZ_READY_WAIT_MS / 1000)}s (the viz shell loaded but the toolbar never appeared). This is usually a cold session or a slow upstream — retrying often works.`;
  } else if (page?.installed === false) {
    errorClass = "NO_CONTENT_SCRIPT";
    message = "The capture content script was not present on the Tableau tab. Reload the extension at edge://extensions, close any open Tableau tabs, then Refresh again.";
  } else if (page?.tableauError) {
    errorClass = "TABLEAU_ERROR";
    message = "Tableau reported an error on the page instead of rendering the viz.";
  } else {
    message = `Tableau viz did not render within ${Math.round(VIZ_READY_WAIT_MS / 1000)}s.`;
  }

  return { errorClass, message, tabUrl: url, page };
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
// pointer event sequences. The sheet is located by matching `sheetMatch`
// (lower-cased substring) against each thumbnail's own label, falling back
// to `fallbackIndex` only if no label matches. Returns
// { ran, ok, reason, steps, sheetNames }.
function exportDriverFn(sheetMatch, fallbackIndex) {
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
  // Resolve the sheet thumbnail by its visible label, remembering what the
  // dialog offered so a miss can be diagnosed from the debug envelope.
  const findSheet = () => {
    const thumbs = [...document.querySelectorAll('[data-tb-test-id^="sheet-thumbnail-"]')];
    if (!thumbs.length) return null;
    steps.sheetNames = thumbs.map((el, i) => `${i}: ${(el.textContent || "").trim().slice(0, 60)}`);
    const needle = String(sheetMatch || "").toLowerCase();
    const byName = needle
      ? thumbs.find((el) => (el.textContent || "").toLowerCase().includes(needle))
      : null;
    if (byName) {
      steps.sheetPickedBy = "name";
      return byName;
    }
    steps.sheetPickedBy = "fallbackIndex";
    return tid(`sheet-thumbnail-${fallbackIndex}`);
  };

  const stages = [
    { name: "download",  find: () => tid("viz-viewer-toolbar-button-download") },
    { name: "crosstab",  find: () => tid("download-flyout-download-crosstab-MenuItem") },
    { name: "sheet",     find: findSheet, pick: (el) => el.querySelector("img,[role=button],button,div") || el },
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
