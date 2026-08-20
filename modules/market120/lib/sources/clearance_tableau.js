// modules/market120/lib/sources/clearance_tableau.js
//
// Open a background Tableau tab pointing at the Clearance/Deleted view with
// the Market 120 filter preset, wait for the content-script capture to land,
// pull the KPI values, close the tab (if we opened it).
//
// Pattern is a verbatim adaptation of
// modules/livedashboard/lib/sources/register.js — same tab lifecycle, same
// executeScript(world:"MAIN") polling, same didOpen ownership rule.
//
// KPIs extracted (Phase 1 vocabulary):
//   clearance_dollars            — Tableau measure "clearance_retail"
//   deleted_dollars              — Tableau measure "Deleted $"
//   deleted_on_clearance_dollars — Tableau measure "deleted_on_clearance_extended_retail"

import { decodeTableauKpis } from "../parse_tableau.js";

const REPORT_URL  = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/Backroom/ClearanceDeleted?Market=120&:iid=1&:linktarget=_self";
const TAB_PATTERN = "https://stores.tableau.wal-mart.com/*Backroom*ClearanceDeleted*";

const CAPTURE_WAIT_MS = 30_000;   // Tableau initial render can take ~20s
const CAPTURE_POLL_MS = 800;
const LOAD_TIMEOUT_MS = 30_000;

// Which substrings identify a response worth parsing. We scan every ring
// entry for the first that contains any of these — order matters (most
// specific first).
const IDENTIFYING_MEASURE_STRINGS = [
  "deleted_on_clearance_extended_retail",
  "clearance_retail",
  "Deleted $",
  "Deleted \\u0024",
];

const MEASURES = [
  "clearance_retail",
  "Deleted $",
  "deleted_on_clearance_extended_retail",
];

export async function fetchClearanceTableau() {
  const opened = await findOrOpenReportTab();
  if (!opened) {
    return { ok: false, errorClass: "TAB", error: "Could not open Tableau ClearanceDeleted tab." };
  }
  const { tab, didOpen } = opened;

  await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);

  // If the tab existed but capture didn't install (e.g. extension reloaded
  // after the page loaded), reload once so the document_start script fires.
  const installed = await isCaptureInstalled(tab.id);
  if (!installed) {
    await chrome.tabs.reload(tab.id, { bypassCache: false });
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
  }

  const captured = await pollForCapture(tab.id, CAPTURE_WAIT_MS, CAPTURE_POLL_MS);
  if (!captured) {
    // Dump the raw ring so we can inspect what the capture actually saw.
    const ringSummary = await dumpRingSummary(tab.id);
    if (didOpen) chrome.tabs.remove(tab.id).catch(() => {});
    return {
      ok: false,
      errorClass: "NO_CAPTURE",
      error: `No VizQL response containing any of [${IDENTIFYING_MEASURE_STRINGS.join(", ")}] within ${CAPTURE_WAIT_MS}ms.`,
      debug: {
        ringSize: ringSummary?.size ?? 0,
        ringUrls: ringSummary?.urls || [],
        ringBodyPreviews: ringSummary?.bodyPreviews || [],
      },
    };
  }

  const parseResult = decodeTableauKpis(captured.respBody, MEASURES);
  const values = parseResult.values;

  // Always try to close a tab we opened, even if parse failed. Leave a
  // pre-existing user tab alone.
  if (didOpen) chrome.tabs.remove(tab.id).catch(() => {});

  if (!parseResult.ok) {
    return {
      ok: false,
      errorClass: "PARSE",
      error: `Tableau parse failed: ${parseResult.reason}`,
      debug: {
        capturedUrl: captured.url,
        respBodyPreview: (captured.respBody || "").slice(0, 4096),
      },
    };
  }

  // Defense-in-depth against "false zeros": the Clearance/Deleted view
  // renders values as server-side PNG tiles, so the measure NAMES appear in
  // schema/descriptor metadata even when no real value is present. A parse
  // that yields only nulls-and-zeros is almost certainly that failure mode,
  // not a genuine $0 store. Surface it as NOT_PARSEABLE so the dashboard
  // shows the unknown marker rather than a misleading "$0" (looks like good
  // news to an exec skimming the tiles).
  const numericValues = Object.values(values).filter((v) => typeof v === "number");
  const allZero = numericValues.every((v) => v === 0);
  if (numericValues.length === 0 || allZero) {
    return {
      ok: false,
      errorClass: "NOT_PARSEABLE",
      error:
        "Clearance/Deleted values not machine-readable (workbook renders KPIs " +
        "as server-side PNG tiles). Showing unknown instead of a misleading $0. " +
        "Tooltip-based capture is the follow-up path.",
      debug: {
        capturedUrl: captured.url,
        parsedValues: values,
        respBodyPreview: (captured.respBody || "").slice(0, 4096),
      },
    };
  }

  return {
    ok: true,
    kpis: {
      clearance_dollars:            values["clearance_retail"] ?? null,
      deleted_dollars:              values["Deleted $"] ?? null,
      deleted_on_clearance_dollars: values["deleted_on_clearance_extended_retail"] ?? null,
    },
    capturedAt: new Date().toISOString(),
    debug: {
      capturedUrl: captured.url,
      matchedStrings: Object.entries(values).filter(([_, v]) => v !== null).map(([k]) => k),
    },
  };
}

// ── Tab management ─────────────────────────────────────────────────
async function findOrOpenReportTab() {
  const existing = await chrome.tabs.query({ url: TAB_PATTERN });
  if (existing.length) return { tab: existing[0], didOpen: false };
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: false });
  return tab ? { tab, didOpen: true } : null;
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
    // allFrames:true — Tableau's viz lives in a child frame (/t/OnlineGrocery/w/...),
    // NOT the top frame, so we must query every frame and check any of them.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => !!window.__APAISUITE_MARKET120_TABLEAU_CAP,
    });
    return (results || []).some((r) => r?.result === true);
  } catch { return false; }
}

async function pollForCapture(tabId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelope = await readAnyIdentifiedCapture(tabId);
    if (envelope) return envelope;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function readAnyIdentifiedCapture(tabId) {
  try {
    // allFrames — the ring lives in the viz iframe's window, not the top window.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      args:   [IDENTIFYING_MEASURE_STRINGS],
      func:   (needles) => {
        const cap = window.__APAISUITE_MARKET120_TABLEAU_CAP;
        if (!cap) return null;
        for (const n of needles) {
          const r = cap.findBySubstr(n);
          if (r) return r;
        }
        return null;
      },
    });
    for (const r of (results || [])) if (r?.result) return r.result;
    return null;
  } catch { return null; }
}

// On NO_CAPTURE, read a summary of the ring so we can see what the content
// script actually intercepted. Bodies are truncated to 800 chars each so the
// summary doesn't blow past chrome.storage.local's per-item limits.
async function dumpRingSummary(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world:  "MAIN",
      func:   () => {
        const cap = window.__APAISUITE_MARKET120_TABLEAU_CAP;
        if (!cap) return { installed: false, url: location.href };
        const all = cap.all();
        return {
          installed: true,
          url: location.href,
          size: all.length,
          urls: all.slice(-20).map((e, i) => `[${i}] ${e.method} ${e.url} → ${e.status}`),
          bodyPreviews: all.slice(-3).map((e, i) => ({
            i,
            url: e.url,
            respBody: (e.respBody || "").slice(0, 800),
          })),
        };
      },
    });
    // Aggregate across frames
    const frames = (results || []).map((r) => r?.result).filter(Boolean);
    return {
      frames: frames.length,
      installed: frames.some((f) => f.installed),
      byFrame: frames,
    };
  } catch { return null; }
}
