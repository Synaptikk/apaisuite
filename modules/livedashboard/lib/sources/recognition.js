// modules/livedashboard/lib/sources/recognition.js
//
// Safety Observations — "Recognition for Stores" table on the
// Field_Dashboard Power BI report. Powers the rolling 7-day recognition
// breakdown shown in the Accident Details drill-down.
//
// Pipeline:
//   1. Find/open background app.powerbi.com tab on the Field_Dashboard
//      Safety Observations page section.
//   2. MAIN-world content script (powerbi_recognition_capture.js) has
//      monkey-patched fetch+XHR; the QES bundle whose body references
//      Description_of_the_Safety_Observation gets ring-buffered.
//   3. Read the latest captured bundle via executeScript MAIN-world.
//   4. If the captured store filter differs from the dashboard's store,
//      mutate the body's fascility_nbr_padded literal and replay in-tab
//      from MAIN world.
//   5. Iterate response.results[] and pick the one whose descriptor.Select
//      names Description_of_the_Safety_Observation. Decode its DSR using
//      the same delta-encoded scheme as register's operator query.
//   6. rollup7d(): group rows by date, return [{date, count}] for the
//      most recent 7 days the data covers (or today-6..today if any rows
//      fall in that window).

import { classifyAuthResponse, isAuthFailureStatus, reloadTabAndWait } from "../../../../shared/auth.js";

const REPORT_ID    = "52d28de7-a2ba-44e5-ab04-689e66eba90f";
const PAGE_ID      = "e8acdf337be7254e2859";   // Safety Observations All Stores
const REPORT_URL   = `https://app.powerbi.com/groups/me/reports/${REPORT_ID}/${PAGE_ID}?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi`;
const TAB_PATTERN  = `https://app.powerbi.com/*${REPORT_ID}*`;

const CAPTURE_WAIT_MS = 25_000;
const CAPTURE_POLL_MS = 600;
const MAX_REAUTH_ATTEMPTS = 2;

// ── Public entry point ─────────────────────────────────────────────

export async function fetchRecognition(storeNbr) {
  const opened = await findOrOpenReportTab();
  if (!opened) return { ok: false, errorClass: "TAB", error: "Could not open Power BI Field_Dashboard tab." };
  const { tab, didOpen } = opened;

  await waitForTabLoad(tab.id, 25_000);

  // After an extension reload, an existing tab's document_start content
  // scripts didn't run on the already-loaded page — reload so it re-injects.
  const installed = await isCaptureInstalled(tab.id);
  if (!installed) {
    await chrome.tabs.reload(tab.id, { bypassCache: false });
    await waitForTabLoad(tab.id, 25_000);
  }

  let result = await runRecognitionPipeline(tab.id, storeNbr, didOpen);
  let reauthAttempts = 0;
  while (result && !result.ok && result.errorClass === "AUTH" && reauthAttempts < MAX_REAUTH_ATTEMPTS) {
    reauthAttempts++;
    console.log(`[livedashboard recognition] auth-shaped response; reloading tab (autonomous reauth ${reauthAttempts}/${MAX_REAUTH_ATTEMPTS})`);
    const reloaded = await reloadTabAndWait(tab.id, {
      settleMs: 4000,
      timeoutMs: 35_000,
      waitForReady: async (tabId) => {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        return !!t?.url && t.url.includes("app.powerbi.com") && t.status === "complete";
      },
    });
    if (!reloaded.ok) {
      console.log(`[livedashboard recognition] reauth reload failed: ${reloaded.reason}`);
      break;
    }
    result = await runRecognitionPipeline(tab.id, storeNbr, false);
  }

  if (reauthAttempts > 0 && result && typeof result === "object") {
    result.reauthAttempts = reauthAttempts;
  }
  return result;
}

async function runRecognitionPipeline(tabId, storeNbr, didOpen) {
  const cap = await pollForCapture(tabId, CAPTURE_WAIT_MS, CAPTURE_POLL_MS);
  if (!cap) {
    return {
      ok: false, errorClass: "NO_CAPTURE",
      error: "Recognition bundle not captured. Open the Safety Observations page once manually so the SPA fires its queries.",
    };
  }

  // If captured store differs from requested, replay with the new filter.
  let respBody = cap.respBody;
  let respStatus = 200, respContentType = "application/json";
  const capturedStore = extractStoreFilter(cap.reqBody);
  const requested = padStore(storeNbr);
  const replay = capturedStore && requested !== capturedStore;
  if (replay) {
    const newBody = swapStoreFilter(cap.reqBody, requested);
    const replayResult = await replayInTab(tabId, cap.url, newBody);
    if (replayResult.ok) {
      respBody        = replayResult.body;
      respStatus      = replayResult.status ?? 200;
      respContentType = replayResult.contentType || respContentType;
    } else {
      // 401 or login HTML — signal AUTH to the outer retry loop.
      const replayAuth = classifyAuthResponse({
        status: replayResult.status ?? 0,
        contentType: replayResult.contentType || "",
        body: replayResult.body || "",
      });
      if (isAuthFailureStatus(replayAuth)) {
        return {
          ok: false, errorClass: "AUTH", authStatus: replayAuth,
          error: `Power BI recognition replay returned ${replayAuth} — autonomous reauth will retry.`,
        };
      }
      return { ok: false, errorClass: "REPLAY", error: `Recognition replay failed: ${replayResult.error || replayResult.status}` };
    }
  }

  // Auth check on the body we're about to decode (catches stale captures
  // where the request returned 200 but the body is login HTML).
  const respAuth = classifyAuthResponse({
    status: respStatus,
    contentType: respContentType,
    body: respBody || "",
  });
  if (isAuthFailureStatus(respAuth)) {
    return {
      ok: false, errorClass: "AUTH", authStatus: respAuth,
      error: `Power BI recognition body classifies as ${respAuth} — autonomous reauth will retry.`,
    };
  }

  const rows = decodeRecognitionResponse(respBody);
  // Rows == 0 isn't an error — the store may simply have no recognitions in
  // the date window. Surface that distinct from a missing result-block.
  const importedAt = new Date().toISOString();

  // We're done with the tab. Only close it if WE opened it — leave alone
  // any pre-existing Power BI tab the user might still be using.
  if (didOpen) {
    chrome.tabs.remove(tabId).catch(() => { /* may already be gone */ });
  }

  return {
    ok: true,
    rows,
    capturedAt:     importedAt,
    capturedStore,
    requestedStore: requested,
    replayed:       replay,
  };
}

// ── Tab management ─────────────────────────────────────────────────

async function findOrOpenReportTab() {
  const existing = await chrome.tabs.query({ url: TAB_PATTERN });
  if (existing.length) return { tab: existing[0], didOpen: false };
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: false });
  return tab ? { tab, didOpen: true } : null;
}

async function waitForTabLoad(tabId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function pollForCapture(tabId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelope = await readCapture(tabId);
    if (envelope) return envelope;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function isCaptureInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func:   () => !!window.__APAISUITE_LIVEDASHBOARD_RECOGNITION_CAP,
    });
    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}

async function readCapture(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func:   () => {
        const cap = window.__APAISUITE_LIVEDASHBOARD_RECOGNITION_CAP;
        return cap?.findRecognition ? cap.findRecognition() : null;
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function replayInTab(tabId, url, body) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [url, body],
      func:   async (u, b) => {
        try {
          const r = await fetch(u, {
            method:      "POST",
            credentials: "include",
            headers:     { "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json" },
            body:        b,
          });
          const contentType = r.headers.get("content-type") || "";
          const text = await r.text().catch(() => "");
          if (!r.ok) return { ok: false, status: r.status, contentType, body: text || null };
          return { ok: true, status: r.status, contentType, body: text };
        } catch (e) {
          return { ok: false, status: 0, error: String(e?.message ?? e) };
        }
      },
    });
    return results?.[0]?.result || { ok: false };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Body editing (store filter swap) ───────────────────────────────
//
// All inner queries in the bundle filter on `fascility_nbr_padded` with a
// padded literal like "'01458'". One Where clause also uses `fascility_nbr`
// (non-padded) for an `IS NOT NULL` check — we leave that untouched.

function padStore(storeNbr) {
  const s = String(storeNbr || "").replace(/\D/g, "");
  return s.padStart(5, "0");
}

function extractStoreFilter(body) {
  if (typeof body !== "string") return null;
  const m = body.match(/"Property":"fascility_nbr_padded"[\s\S]{0,400}?"Value":"'(\d+)'"/);
  return m ? m[1] : null;
}

function swapStoreFilter(body, newStorePadded) {
  if (typeof body !== "string") return body;
  return body.replace(
    /("Property":"fascility_nbr_padded"[\s\S]{0,400}?"Value":")'\d+'(")/g,
    `$1'${newStorePadded}'$2`,
  );
}

// ── DSR decoder for the Recognition table inner result ─────────────

const SELECT_DESCRIPTION = "High_Accidents_Survey.Description_of_the_Safety_Observation";
const SELECT_DATE        = "Calendar.GREGORIAN_DATE";
const SELECT_STORE       = "Stores Master.fascility_nbr_padded";

export function decodeRecognitionResponse(respBody) {
  if (!respBody) return [];
  let resp;
  try { resp = JSON.parse(respBody); } catch { return []; }
  const results = resp?.results || [];

  // Find the inner result whose descriptor.Select names the description
  // column — that's the row-level "Recognition for Stores" table.
  const match = results.find((r) => {
    const sel = r?.result?.data?.descriptor?.Select || [];
    return sel.some((s) => s?.Name === SELECT_DESCRIPTION);
  });
  if (!match) return [];

  const data = match.result.data;
  const ds   = data?.dsr?.DS?.[0];
  if (!ds) return [];

  const dm = ds.PH?.[0]?.DM0 || [];
  if (!dm.length) return [];

  // First entry carries the schema (S); subsequent entries are data rows
  // with delta encoding: R is a bitmask of which positions repeat from prev.
  const schema = dm[0].S;
  if (!schema) return [];
  const dicts = ds.ValueDicts || {};

  // Map Select.Name → schema position index. The DM rows' S array is in the
  // same order as descriptor.Select. We resolve by Select.Name lookup so
  // future column re-ordering by Power BI doesn't break the decoder.
  const selects = data.descriptor.Select;
  const posByName = {};
  for (let i = 0; i < schema.length; i++) {
    posByName[selects[i]?.Name] = i;
  }
  const iDesc  = posByName[SELECT_DESCRIPTION];
  const iDate  = posByName[SELECT_DATE];
  const iStore = posByName[SELECT_STORE];
  if (iDesc == null || iDate == null || iStore == null) return [];

  const out = [];
  let prev = new Array(schema.length).fill(null);
  for (const e of dm) {
    const c = e.C || [];
    const r = e.R ?? 0;
    const row = new Array(schema.length);
    let ci = 0;
    for (let j = 0; j < schema.length; j++) {
      if ((r >> j) & 1) row[j] = prev[j];
      else              row[j] = ci < c.length ? c[ci++] : null;
    }
    prev = row;

    // Resolve dict-ref columns
    const descCol  = schema[iDesc];
    const storeCol = schema[iStore];
    const description = descCol.DN && typeof row[iDesc]  === "number"
      ? (dicts[descCol.DN] || [])[row[iDesc]]
      : row[iDesc];
    const store = storeCol.DN && typeof row[iStore] === "number"
      ? (dicts[storeCol.DN] || [])[row[iStore]]
      : row[iStore];
    const dateMs = row[iDate];
    const dateIso = typeof dateMs === "number" ? epochToIsoDate(dateMs) : null;
    if (!dateIso) continue;
    out.push({
      storeNbr:    String(store || ""),
      dateIso,
      description: String(description || ""),
    });
  }
  return out;
}

function epochToIsoDate(ms) {
  if (typeof ms !== "number") return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Rolling 7-day rollup ───────────────────────────────────────────
//
// Group rows by dateIso and return the most recent 7 distinct dates from
// (today-6 .. today) inclusive — days with zero observations show as count
// 0 rather than being skipped, so the drill-down always renders 7 rows.

export function rollup7d(rows, todayIso = isoToday()) {
  const counts = new Map();
  for (const r of rows) {
    if (!r.dateIso) continue;
    counts.set(r.dateIso, (counts.get(r.dateIso) || 0) + 1);
  }
  const out = [];
  const today = new Date(todayIso + "T00:00:00Z");
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ dateIso: iso, count: counts.get(iso) || 0 });
  }
  return out;
}

function isoToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
