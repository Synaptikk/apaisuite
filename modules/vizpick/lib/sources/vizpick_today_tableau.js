// modules/vizpick/lib/sources/vizpick_today_tableau.js
//
// Current-day ("Today") capture from the VizPickDetails view.
//
// WHY THIS IS SHAPED SO DIFFERENTLY FROM THE YESTERDAY CAPTURE
// ------------------------------------------------------------
// Discovered live 2026-08-16 (dev/probe-vizpick-view.mjs +
// dev/probe-vizpick-details-scope.mjs):
//
//   · views/VizPick/VizPick        → "This dashboard is refreshed daily for
//     the day prior."  Its date filter offers only 1. Yesterday, 2. Week to
//     Date, 3. Last WM Week, 4. Last 7 Days, 5. Last 30 Days — there is no
//     Today bucket. It DOES have a "Download Summary by Store" sheet, so one
//     export yields every store in every market.
//
//   · views/VizPick/VizPickDetails → "This dashboard is refreshed frequently
//     for the current business day. Data can be approximately 1-2 Hours
//     behind depending on upstream systems."  This is the only source of
//     current-day numbers. But it is scoped to ONE store at a time via a
//     Tableau *parameter* (a text box, aria-label="Store"), and it has no
//     Summary-by-Store sheet — only "Download Department Breakout (Current
//     Day)", whose "Total" row is that one store's rollup.
//
// So a market-wide Today necessarily means: set the Store parameter, wait for
// the viz to re-query, export, parse, repeat. That is one full export cycle
// per store, which is why the UI loads Today on demand rather than
// automatically.
//
// Read-only: sets a client-side view parameter and exports data that already
// exists. Nothing is written back to the workbook (Tableau parameter state on
// a view is per-session unless explicitly saved as a custom view, which we
// never do).

import { parseDeptBreakout, parseDonutHealth, parseLastUpdate } from "../parse_vizpick_stores_csv.js";

const DETAILS_URL = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self";
// See the note in vizpick_stores_tableau.js: Tableau's view name lives in the
// URL fragment, which chrome.tabs.query match patterns cannot see.
const TAB_PATTERN   = "https://stores.tableau.wal-mart.com/*";
const VIEW_FRAGMENT = /\/views\/VizPick\/VizPickDetails(?:$|[?#])/i;

const LOAD_TIMEOUT_MS   = 30_000;
const VIZ_READY_WAIT_MS = 120_000;  // cold session + SSO redirect chain; see the stores source
const EXPORT_WAIT_MS    = 45_000;
const UPDATE_WAIT_MS    = 20_000;
const REQUERY_WAIT_MS   = 25_000;  // how long to wait for the viz to re-query after a store change
const SETTLE_MS         = 1_500;   // extra beat after the last vizql response lands
const DIALOG_SETTLE_MS  = 20_000;  // wait for the viz toolbar to reappear after a dialog closes
const POLL_MS           = 700;
const INSTALL_GRACE_MS  = 3_000;

const DEPT_SHEET   = { match: "download department breakout (current day)", fallbackIndex: 3 };
// The department breakout has no Location %, Overstock % or VizPick composite —
// only this sheet carries the current-day equivalents of the dashboard rings,
// which is why each store costs two exports rather than one.
const DONUT_SHEET  = { match: "vizpick donut health", fallbackIndex: 11 };
const UPDATE_SHEET = { match: "last update",                                fallbackIndex: 6 };

// Header unique to the department-breakout export; "Suggested Picks" does not
// appear in the Summary-by-Store crosstab, so it cannot cross-match.
const DEPT_CSV_NEEDLE = "Suggested Picks";
// Unique to the donut-health sheet.
const DONUT_CSV_NEEDLE = "New VizPick";

/**
 * Capture current-day figures for a list of stores.
 *
 * @param {string[]} stores       Store numbers, in the order to visit them.
 * @param {object}   [opts]
 * @param {(p:{done:number,total:number,store:string})=>void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled]  Polled between stores.
 * @returns {Promise<object>}
 */
export async function fetchVizpickTodayTableau(stores, opts = {}) {
  const wanted = (stores || []).map((s) => String(s).trim()).filter(Boolean);
  if (!wanted.length) {
    return { ok: false, errorClass: "INPUT", error: "No stores requested for the Today capture." };
  }

  const opened = await findOrOpenReportTab();
  if (!opened) {
    return { ok: false, errorClass: "TAB", error: "Could not open the Tableau VizPick Details tab." };
  }
  const { tab, didOpen } = opened;

  // Background tab, never focused — see the note in vizpick_stores_tableau.js.
  // It matters far more here: this loop runs one export per store, so
  // foregrounding would yank the user out of whatever they're doing once per
  // store for several minutes.

  let succeeded = false;
  const rows = [];
  const failures = [];

  try {
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);

    if (!(await waitForCaptureInstalled(tab.id, INSTALL_GRACE_MS))) {
      await chrome.tabs.reload(tab.id, { bypassCache: false });
      await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
      await waitForCaptureInstalled(tab.id, INSTALL_GRACE_MS);
    }

    if (!(await waitForVizReady(tab.id, VIZ_READY_WAIT_MS))) {
      return {
        ok: false,
        errorClass: "SESSION",
        error: "VizPick Details did not render in time (session may need SSO re-auth). " +
               "The tab was left open — confirm data renders there, then try again.",
        keptTabOpen: true,
      };
    }

    // One export per store would mean one downloaded file per store on every
    // refresh. We already hold the bytes from the Blob, so suppress the write.
    await setSuppressDownloads(tab.id, true);

    // ── Source timestamp. On this view it is a FULL timestamp
    // ("2026-08-16 10:26:07"), which is what makes an honest absolute
    // "Last updated" display possible for Today.
    let sourceUpdate = null;
    try {
      await clearRing(tab.id);
      const t = await triggerCrosstabExport(tab.id, UPDATE_SHEET);
      if (t.ok) {
        const lu = await pollForCsv(tab.id, UPDATE_WAIT_MS, "\t");
        if (lu) {
          const p = parseLastUpdate(lu.respBody);
          if (p.ok) sourceUpdate = { raw: p.raw, iso: p.iso, hasTime: p.hasTime };
        }
      }
    } catch { /* metadata only */ }

    // ── Per-store loop ─────────────────────────────────────────────────
    for (let i = 0; i < wanted.length; i++) {
      if (opts.isCancelled?.()) {
        return { ok: false, errorClass: "CANCELLED", error: "Today capture cancelled.", rows, sourceUpdate, keptTabOpen: true };
      }
      const store = wanted[i];
      opts.onProgress?.({ done: i, total: wanted.length, store });

      try {
        // Clear first so "a new vizql response arrived" is an unambiguous
        // signal that THIS store's re-query completed.
        await clearRing(tab.id);

        const set = await setStoreParameter(tab.id, store);
        if (!set.ok) { failures.push({ store, reason: `parameter: ${set.reason}` }); continue; }

        // Wait for Tableau to actually re-query before exporting. Without
        // this the export races the parameter change and silently returns
        // the PREVIOUS store's numbers — the worst possible failure, since
        // it looks like valid data.
        const requeried = await waitForRequery(tab.id, REQUERY_WAIT_MS);
        if (!requeried) { failures.push({ store, reason: "viz did not re-query after store change" }); continue; }
        await sleep(SETTLE_MS);

        await clearRing(tab.id);
        const triggered = await triggerCrosstabExport(tab.id, DEPT_SHEET);
        if (!triggered.ok) { failures.push({ store, reason: `export UI: ${triggered.reason}` }); continue; }

        const csv = await pollForCsv(tab.id, EXPORT_WAIT_MS, DEPT_CSV_NEEDLE);
        if (!csv) { failures.push({ store, reason: "no department-breakout CSV captured" }); continue; }

        const parsed = parseDeptBreakout(csv.respBody);
        if (!parsed.ok) { failures.push({ store, reason: `parse: ${parsed.reason}` }); continue; }

        // Second export for this same store: the donut-health sheet, which is
        // the only current-day source of Location %, Overstock % and the
        // VizPick composite. The viz is already showing this store, so no
        // re-query is needed — just re-open the dialog on a different sheet.
        // Non-fatal: without it the card still renders its picks/cases
        // numbers, just without those three rings.
        let health = null;
        try {
          // The crosstab dialog from the export above is still tearing down,
          // and while it is up Tableau removes the viz toolbar from the DOM —
          // so firing the next export immediately finds no Download button and
          // silently does nothing. Wait for the toolbar to come back first.
          await sleep(SETTLE_MS);
          const toolbarBack = await waitForVizReady(tab.id, DIALOG_SETTLE_MS);
          if (!toolbarBack) {
            failures.push({ store, reason: "toolbar did not return after the first export", soft: true });
          } else {
            await clearRing(tab.id);
            const dt = await triggerCrosstabExport(tab.id, DONUT_SHEET);
            if (!dt.ok) {
              // Previously this branch was silent, so a failed second export
              // looked like a clean run that just happened to have no health
              // data. Always record it.
              failures.push({ store, reason: `donut export UI: ${dt.reason}`, soft: true });
            } else {
              const dcsv = await pollForCsv(tab.id, EXPORT_WAIT_MS, DONUT_CSV_NEEDLE);
              if (dcsv) {
                const dh = parseDonutHealth(dcsv.respBody);
                if (dh.ok) health = dh.health;
                else failures.push({ store, reason: `donut parse: ${dh.reason}`, soft: true });
              } else {
                failures.push({ store, reason: "no donut-health CSV captured", soft: true });
              }
            }
          }
        } catch (e) {
          failures.push({ store, reason: `donut: ${String(e?.message ?? e)}`, soft: true });
        }

        rows.push({ store, ...parsed.total, ...(health || {}), deptCount: parsed.deptCount, hasHealth: !!health });
      } catch (e) {
        failures.push({ store, reason: String(e?.message ?? e) });
      }
    }
    opts.onProgress?.({ done: wanted.length, total: wanted.length, store: null });

    if (!rows.length) {
      return {
        ok: false,
        errorClass: "NO_CAPTURE",
        error: `Captured no current-day data for any of the ${wanted.length} requested stores.`,
        debug: { failures },
        keptTabOpen: true,
      };
    }

    succeeded = true;
    return {
      ok: true,
      rows,
      sourceUpdate,
      capturedAt: new Date().toISOString(),
      // Partial success is normal here: a market can contain a store the
      // user's Tableau row-level security doesn't cover.
      partial: failures.length > 0,
      debug: {
        requested: wanted.length,
        captured: rows.length,
        withHealth: rows.filter((r) => r.hasHealth).length,
        failures,
      },
    };
  } finally {
    await setSuppressDownloads(tab.id, false);
    if (didOpen && succeeded) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Store parameter ────────────────────────────────────────────────────────
// The Store control is a Tableau parameter rendered as a <textarea> with
// aria-label="Store" and the hint "After typing a new value, press ENTER to
// commit or Escape to revert." React-style value setters must be used or the
// framework never sees the change.
async function setStoreParameter(tabId, store) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [store],
      func:   (value) => {
        const el =
          document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]') ||
          [...document.querySelectorAll("textarea,input")].find(
            (n) => (n.getAttribute("aria-label") || "").trim().toLowerCase() === "store"
          );
        if (!el) return { ok: false, reason: "no Store parameter input in this frame" };

        const before = el.value;
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        el.focus();
        if (setter) setter.call(el, String(value)); else el.value = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, {
            bubbles: true, cancelable: true,
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
          }));
        }
        el.blur();
        return { ok: true, before, after: el.value };
      },
    });
    for (const r of (results || [])) if (r?.result?.ok) return r.result;
    return { ok: false, reason: (results || []).map((r) => r?.result?.reason).find(Boolean) || "not found in any frame" };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

// A non-blob ring entry means a vizql/dataserver response landed, i.e. the
// viz re-queried for the newly selected store.
async function waitForRequery(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => (window.__APAISUITE_VIZPICK_TABLEAU_CAP?.all?.() || []).some((e) => e.via !== "blob"),
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

// ── Tab lifecycle (mirrors vizpick_stores_tableau.js) ─────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findOrOpenReportTab() {
  const all = await chrome.tabs.query({ url: TAB_PATTERN });
  const existing = all.filter((t) => VIEW_FRAGMENT.test(t.url || ""));
  if (existing.length) return { tab: existing[0], didOpen: false };
  // active:false — the capture runs entirely in the background and must
  // never pull the user off the page they are on.
  const tab = await chrome.tabs.create({ url: DETAILS_URL, active: false });
  return tab ? { tab, didOpen: true } : null;
}



async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await sleep(250);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function waitForCaptureInstalled(tabId, graceMs) {
  const deadline = Date.now() + graceMs;
  do {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => !!window.__APAISUITE_VIZPICK_TABLEAU_CAP,
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(250);
  } while (Date.now() < deadline);
  return false;
}

async function waitForVizReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        func:   () => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
      });
      if ((results || []).some((r) => r?.result === true)) return true;
    } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

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

async function pollForCsv(tabId, timeoutMs, needle) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        args:   [needle],
        func:   (n) => window.__APAISUITE_VIZPICK_TABLEAU_CAP?.findBlobBySubstr?.(n) || null,
      });
      for (const r of (results || [])) if (r?.result) return r.result;
    } catch {}
    await sleep(POLL_MS);
  }
  return null;
}

async function triggerCrosstabExport(tabId, sheet) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world:  "MAIN",
    args:   [sheet.match, sheet.fallbackIndex],
    func:   exportDriverFn,
  });
  for (const r of (results || [])) if (r?.result && r.result.ran) return r.result;
  return { ok: false, reason: "viz frame with toolbar not found" };
}

// Same staged driver as the yesterday source; kept local so this file stays
// self-contained when injected.
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

  if (!tid("viz-viewer-toolbar-button-download")) return { ran: false, ok: false, reason: "no toolbar in this frame" };

  const findSheet = () => {
    const thumbs = [...document.querySelectorAll('[data-tb-test-id^="sheet-thumbnail-"]')];
    if (!thumbs.length) return null;
    steps.sheetNames = thumbs.map((el, i) => `${i}: ${(el.textContent || "").trim().slice(0, 60)}`);
    const needle = String(sheetMatch || "").toLowerCase();
    const byName = needle ? thumbs.find((el) => (el.textContent || "").toLowerCase().includes(needle)) : null;
    if (byName) { steps.sheetPickedBy = "name"; return byName; }
    steps.sheetPickedBy = "fallbackIndex";
    return tid(`sheet-thumbnail-${fallbackIndex}`);
  };

  const stages = [
    { name: "download", find: () => tid("viz-viewer-toolbar-button-download") },
    { name: "crosstab", find: () => tid("download-flyout-download-crosstab-MenuItem") },
    { name: "sheet",    find: findSheet, pick: (el) => el.querySelector("img,[role=button],button,div") || el },
    { name: "csv",      find: () => tid("crosstab-options-dialog-radio-csv-RadioButton"), pick: (el) => el.querySelector("input") || el },
    { name: "export",   find: () => tid("export-crosstab-export-Button"), ready: (el) => !el.disabled },
  ];

  let i = 0, ticks = 0;
  const MAX_TICKS = 60;
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
