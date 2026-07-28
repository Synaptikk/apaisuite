// modules/metricshot/lib/sources/vizpick_scrape.js
//
// Pull VizPick's Location Details + Department Breakout row data from the
// Tableau VizQL response captured by content/tableau_capture.js.
//
// Called AFTER the screenshot capture — by that time the target tab is
// already open + primed + rendered, so we don't need to re-open or re-inject
// parameters. We just read whatever the ring buffer captured.
//
// Adaptation of modules/market120/lib/sources/clearance_tableau.js, scoped
// to metricshot's own capture ring.

import { parseVizPickResponse } from "../parse_vizpick.js";

const TAB_PATTERN_EMBED    = "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/*";
const TAB_PATTERN_VIZPORTAL = "https://stores.tableau.wal-mart.com/*VizPick*";

// Any of these substrings, if present in the ring, likely marks a payload
// worth parsing. Location Age is unique to VizPick. Department numbers alone
// are too generic to filter on.
const IDENTIFYING_STRINGS = [
  "Location Age",
  "location_age",
  "hoursSinceLastScan",
  "VizPickLocations",
  "Cases Seen %",
];

const CAPTURE_WAIT_MS = 20_000;
const CAPTURE_POLL_MS = 800;

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   locationDetails?: object[],
 *   departmentBreakout?: object[],
 *   error?: string,
 *   errorClass?: string,
 *   debug?: object,
 * }>}
 */
export async function scrapeVizPick() {
  const tabId = await _findVizPickTabId();
  if (!tabId) return { ok: false, errorClass: "NO_TAB", error: "no VizPick tab open" };

  // Confirm capture is installed. Content script runs at document_start on the
  // Tableau host; if we opened the tab AFTER an extension reload it should be
  // there. If not, a reload will fix it — but that would blow away the just-
  // taken screenshot's tab state. So we accept the miss and log.
  const installed = await _isCaptureInstalled(tabId);
  if (!installed) {
    return { ok: false, errorClass: "NO_CAPTURE", error: "tableau_capture content script not installed in tab" };
  }

  const captured = await _pollForCapture(tabId, CAPTURE_WAIT_MS, CAPTURE_POLL_MS);
  if (!captured) {
    const ringSummary = await _dumpRingSummary(tabId);
    return {
      ok: false,
      errorClass: "NO_MATCH",
      error: `no VizQL response containing any of [${IDENTIFYING_STRINGS.join(", ")}] within ${CAPTURE_WAIT_MS}ms`,
      debug: { ringSummary },
    };
  }

  const parsed = parseVizPickResponse(captured.respBody);
  if (!parsed.ok) {
    return {
      ok: false,
      errorClass: "PARSE",
      error: `parseVizPickResponse failed: ${parsed.reason}`,
      debug: {
        capturedUrl: captured.url,
        respBodyPreview: (captured.respBody || "").slice(0, 4096),
      },
    };
  }

  return {
    ok: true,
    locationDetails: parsed.locationDetails,
    departmentBreakout: parsed.departmentBreakout,
    debug: { capturedUrl: captured.url, bodyLen: captured.respBody?.length ?? 0 },
  };
}

async function _findVizPickTabId() {
  let tabs = await chrome.tabs.query({ url: TAB_PATTERN_EMBED });
  if (!tabs.length) tabs = await chrome.tabs.query({ url: TAB_PATTERN_VIZPORTAL });
  const usable = tabs.filter((t) => typeof t.id === "number")
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return usable[0]?.id ?? null;
}

async function _isCaptureInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => !!window.__APAISUITE_METRICSHOT_TABLEAU_CAP,
    });
    return (results || []).some((r) => r?.result === true);
  } catch { return false; }
}

async function _pollForCapture(tabId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await _readAnyIdentifiedCapture(tabId);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function _readAnyIdentifiedCapture(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      args: [IDENTIFYING_STRINGS],
      func: (needles) => {
        const cap = window.__APAISUITE_METRICSHOT_TABLEAU_CAP;
        if (!cap) return null;
        for (const n of needles) {
          const r = cap.findBySubstr(n);
          if (r) return r;
        }
        return null;
      },
    });
    for (const r of results || []) if (r?.result) return r.result;
    return null;
  } catch { return null; }
}

async function _dumpRingSummary(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        const cap = window.__APAISUITE_METRICSHOT_TABLEAU_CAP;
        if (!cap) return { installed: false, url: location.href };
        const all = cap.all();
        return {
          installed: true,
          url: location.href,
          size: all.length,
          urls: all.slice(-15).map((e) => `${e.method} ${e.url} → ${e.status}`),
          bodyPreviews: all.slice(-3).map((e) => ({
            url: e.url, respBody: (e.respBody || "").slice(0, 800),
          })),
        };
      },
    });
    const frames = (results || []).map((r) => r?.result).filter(Boolean);
    return { frames: frames.length, byFrame: frames };
  } catch { return null; }
}
