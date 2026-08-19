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
// Hard ceiling for the whole capture. The individual waits above can stack to
// roughly four minutes in the worst case (slow load -> reload -> cold viz ->
// two exports), and without an overall bound a single wedged step leaves the
// UI spinning indefinitely. Whatever happens, this returns.
const OVERALL_BUDGET_MS = 300_000;

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

/**
 * @param {object} [opts]
 * @param {string|null} [opts.knownSourceKey]  Stamp of the data already stored.
 * @param {boolean} [opts.force]  Re-export even if the stamp is unchanged.
 * @param {(phase:string)=>void} [opts.onPhase]  Progress narration; a capture
 *   can run for minutes and a bare spinner tells the user nothing.
 */
export async function fetchVizpickStoresTableau(opts = {}) {
  const deadline = Date.now() + OVERALL_BUDGET_MS;
  const budgetLeft = () => deadline - Date.now();
  const phase = (p) => { try { opts.onPhase?.(p); } catch {} };
  // Cap any individual wait at whatever is left of the overall budget.
  const within = (ms) => Math.max(0, Math.min(ms, budgetLeft()));
  const opened = await findOrOpenReportTab();
  if (!opened) {
    return { ok: false, errorClass: "TAB", error: "Could not open Tableau VizPick tab." };
  }
  const { tab, didOpen } = opened;

  // The capture tab is opened in the BACKGROUND and never focused. An earlier
  // version foregrounded it on the theory that Tableau's rAF-driven render is
  // throttled in background tabs — but everything this capture touches is
  // DOM, not canvas: we wait for the toolbar button to exist, click through
  // the crosstab dialog, and read the CSV out of a Blob. None of that needs
  // painted pixels. Stealing focus mid-task is worse than a slower render,
  // and the viz-ready budget is generous enough to absorb it.

  // Only close the tab we opened when the capture actually SUCCEEDS. On any
  // failure (session/SSO, render timeout, export UI), leave it open so the
  // user can see what happened and re-auth if needed.
  // A run the USER started leaves a failed tab open so they can look at it.
  // A background auto-check must not: the user never asked for a tab, so an
  // orphan is litter — and if it is later closed, an error still telling them
  // to "confirm data renders there" points at nothing.
  const keepFailedTab = !opts.auto;
  const tabHint = keepFailedTab
    ? " The tab was left open — confirm data renders there, then Refresh again."
    : " This ran automatically in the background; its tab was closed. Open the module and click Refresh to see the failure live.";

  let succeeded = false;

  try {
    phase(didOpen ? "Opening Tableau…" : "Using the open Tableau tab…");
    await waitForTabLoad(tab.id, within(LOAD_TIMEOUT_MS));

    if (!(await waitForCaptureInstalled(tab.id, within(INSTALL_GRACE_MS)))) {
      phase("Reloading the Tableau tab…");
      await chrome.tabs.reload(tab.id, { bypassCache: false });
      await waitForTabLoad(tab.id, within(LOAD_TIMEOUT_MS));
      await waitForCaptureInstalled(tab.id, within(INSTALL_GRACE_MS));
    }

    phase("Waiting for the VizPick dashboard to render…");
    const ready = await waitForVizReady(tab.id, within(VIZ_READY_WAIT_MS));
    if (!ready) {
      // A bare "did not render in time" is unactionable — it can mean SSO,
      // a slow cold render, a Tableau error dialog, or the tab having been
      // navigated somewhere else entirely. Look at the page and say which.
      const diag = await diagnoseUnrenderedTab(tab.id);
      return {
        ok: false,
        errorClass: diag.errorClass,
        error: diag.message + tabHint,
        debug: diag,
        keptTabOpen: keepFailedTab,
      };
    }

    // ── Source timestamp first ──────────────────────────────────────────
    // The workbook's own "Last update" sheet is the authoritative refresh
    // stamp. Capture it before the big export so that even a later parse
    // failure still tells the UI how fresh Tableau's data actually is. On
    // this view it is a DATE only ("8/16/2026"); VizPickDetails carries a
    // full timestamp. A miss here is non-fatal — the store data is the
    // point, the stamp is metadata.
    // Everything from here on drives Tableau's own export, so the file write
    // is ours to suppress. Disarmed again in the finally block.
    await setSuppressDownloads(tab.id, true);

    phase("Reading Tableau's last-update stamp…");
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

    // ── Skip the expensive export when nothing has been republished ─────
    // The store crosstab is ~4,600 rows; re-exporting it when Tableau has not
    // refreshed just burns time and re-writes identical data. The "Last
    // update" stamp read above is the cheap way to know.
    if (!opts.force && opts.knownSourceKey && sourceUpdate?.raw && sourceUpdate.raw === opts.knownSourceKey) {
      succeeded = true;   // nothing failed — let the finally block tidy the tab
      return {
        ok: true,
        unchanged: true,
        sourceUpdate,
        checkedAt: new Date().toISOString(),
      };
    }

    phase("Exporting every store…");
    // Clear the ring so we only match the CSV from *this* export, not a stale one.
    await clearRing(tab.id);

    if (budgetLeft() <= 0) {
      return {
        ok: false,
        errorClass: "TIMEOUT",
        error: `Gave up after ${Math.round(OVERALL_BUDGET_MS / 1000)}s. The tab was left open — check whether Tableau is responding there.`,
        keptTabOpen: keepFailedTab,
      };
    }

    const triggered = await triggerCrosstabExport(tab.id, STORE_SHEET);
    if (!triggered.ok) {
      return { ok: false, errorClass: "EXPORT_UI", error: `Could not drive crosstab export: ${triggered.reason}`, debug: triggered, keptTabOpen: true };
    }

    const csv = await pollForCsv(tab.id, within(EXPORT_WAIT_MS), POLL_MS);
    if (!csv) {
      const ring = await dumpRingSummary(tab.id);
      return {
        ok: false,
        errorClass: "NO_CAPTURE",
        error: `No CSV containing "${STORE_CSV_NEEDLE}" captured within ${EXPORT_WAIT_MS}ms.`,
        debug: ring,
        keptTabOpen: keepFailedTab,
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

    phase("Parsing…");
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
    // Never leave the interceptor armed — a user-initiated download in this
    // tab afterwards must behave normally.
    await setSuppressDownloads(tab.id, false);
    // Close the tab only if we opened it AND the capture succeeded. Leaving
    // a failed tab open lets the user re-auth / inspect. No focus restore is
    // needed: we never took focus in the first place.
    if (didOpen && (succeeded || !keepFailedTab)) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

// ── Tab management (same lifecycle as market120's clearance_stores_tableau.js) ──
async function findOrOpenReportTab() {
  const all = await chrome.tabs.query({ url: TAB_PATTERN });
  const existing = all.filter((t) => VIEW_FRAGMENT.test(t.url || ""));
  if (existing.length) {
    // Prefer a tab Chrome has not reclaimed. `frozen` is the one that looks
    // healthy and is not: status stays "complete" while the event loop is
    // SUSPENDED, so the viz never renders and injected polls never run. See
    // the long note in vizpick_today_tableau.js — this source has only been
    // luckier, not immune, because its tab tends to have been used recently.
    const live = existing.find((t) => !t.discarded && !t.frozen) || existing[0];
    if (live.discarded || live.frozen) {
      await chrome.tabs.reload(live.id, { bypassCache: false }).catch(() => {});
    }
    await keepAwake(live.id);
    return { tab: live, didOpen: false, dormant: !!(live.discarded || live.frozen) };
  }
  // active:false — the capture runs entirely in the background and must
  // never pull the user off the page they are on.
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: false });
  if (tab) await keepAwake(tab.id);
  return tab ? { tab, didOpen: true } : null;
}

/** Ask Chrome not to reclaim a tab we are about to drive. */
async function keepAwake(tabId) {
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch {}

  // autoDiscardable only stops Chrome DISCARDING the tab. It does not stop
  // Chrome FREEZING it, which suspends JS execution outright — and a frozen
  // tab is why captures failed with "the page shell loaded but the viz never
  // finished": the document was complete, then execution stopped, so Tableau's
  // render never ran to completion. A status snapshot caught it red-handed:
  // { view: "VizPickDetails", discarded: false, frozen: true }.
  //
  // Two parts, because they solve different halves:
  //
  //   1. A tab that is ALREADY frozen when we adopt it stays frozen; nothing
  //      we set afterwards revives it. Reloading does, so reload it. Losing
  //      the current render costs nothing — a frozen tab renders nothing.
  //   2. Hold a Web Lock in the page. An unreleased lock marks the page as
  //      doing work, which is one of the conditions Chrome's freezing
  //      intervention exempts. Best-effort: the exemption list is a browser
  //      heuristic, not a contract, so this reduces re-freezing rather than
  //      guaranteeing against it.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.frozen) {
      await chrome.tabs.reload(tabId);
      await _awaitTabComplete(tabId, 30_000);
    }
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func: () => {
        if (window.__apaiKeepAwake) return;
        window.__apaiKeepAwake = true;
        try {
          // Never resolves, so the lock is held for the life of the document.
          navigator.locks?.request?.("apaisuite-keep-awake", { mode: "exclusive" },
            () => new Promise(() => {}));
        } catch { /* Web Locks unavailable — fall through, nothing lost */ }
      },
    });
  } catch {}
}

// Resolve once the tab reports status "complete", or after `timeoutMs`.
// Polling rather than onUpdated: this runs inside a capture that may already
// hold listeners for the same tab, and a stray listener outliving its capture
// is how lanes started interfering with each other.
async function _awaitTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete" && !t.frozen) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
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

// Arm/disarm the content script's download interceptor. We already hold the
// CSV bytes from the Blob, so the file write is pure noise — but it must only
// be suppressed while OUR export is running, never for a download the user
// starts by hand.
async function setSuppressDownloads(tabId, on) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [!!on],
      func:   (v) => { window.__APAISUITE_VIZPICK_TABLEAU_CAP?.setSuppressDownloads?.(v); },
    });
  } catch {}
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
