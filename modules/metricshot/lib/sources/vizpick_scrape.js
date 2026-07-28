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
        bodyLen: captured.respBody?.length ?? 0,
        // A raw head-slice is useless — the first few KB are just dashboard
        // layout/zone chrome. The row data lives deep in dataDictionary /
        // dataValues. Extract targeted windows around those markers so the
        // shared debug snippet actually contains the columns the parser needs.
        respBodyPreview: _dataWindows(captured.respBody),
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

// Pull targeted windows out of the (huge) Tableau body around the markers
// that actually carry row data, so the debug snippet we surface/share is
// useful for tuning the parser rather than 4KB of dashboard chrome. Returns
// a concatenation of labelled excerpts, capped to stay under storage quota.
function _dataWindows(body) {
  if (!body || typeof body !== "string") return "";
  const markers = [
    "dataDictionary",
    "dataSegments",
    "dataColumns",
    "dataValues",
    "fieldCaption",
    "Location Age",
    "Cases Seen",
    "Pick %",
    "vizData",
    "paneColumnsData",
  ];
  const WINDOW = 3000;      // chars each side of a marker hit
  const MAX_HITS = 12;      // don't dump the whole body
  const MAX_TOTAL = 60_000; // storage-quota safety
  const out = [];
  let total = 0;
  const seen = [];
  for (const marker of markers) {
    let from = 0, hits = 0;
    while (hits < 3) {
      const idx = body.indexOf(marker, from);
      if (idx < 0) break;
      // Skip if this window heavily overlaps one we already grabbed.
      if (seen.some((s) => Math.abs(s - idx) < WINDOW)) { from = idx + marker.length; continue; }
      const start = Math.max(0, idx - WINDOW);
      const end = Math.min(body.length, idx + WINDOW);
      const excerpt = body.slice(start, end);
      out.push(`\n\n===== "${marker}" @${idx} (\u00b1${WINDOW}) =====\n${excerpt}`);
      seen.push(idx);
      total += excerpt.length;
      hits++;
      from = idx + marker.length;
      if (out.length >= MAX_HITS || total >= MAX_TOTAL) break;
    }
    if (out.length >= MAX_HITS || total >= MAX_TOTAL) break;
  }
  if (!out.length) {
    // No data markers at all — fall back to a head slice + a tail slice so we
    // can at least see both ends of whatever this response is.
    return `(no data markers found; body ${body.length} chars)\n--- HEAD ---\n`
      + body.slice(0, 4000) + `\n--- TAIL ---\n` + body.slice(-4000);
  }
  return `(body ${body.length} chars; ${out.length} windows)` + out.join("");
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
