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

// Field_Dashboard was republished on/around 2026-08-12 under a new workspace
// (fd8e7aa4-…) with a NEW report id. The old artifact 52d28de7-a2ba-44e5-ab04-
// 689e66eba90f now answers "Failed to get access request info for this
// artifact" and bounces to app.powerbi.com/ — the report never renders, so the
// SPA never fires its QES queries and every pull died with NO_CAPTURE.
// `/groups/me/` still resolves the new id (Power BI rewrites it), so the URL
// shape is unchanged. Verified 2026-08-31: cold deep-link captures in ~8s.
const REPORT_ID    = "04aa0743-2bb9-4e34-b19d-5089b1832b6a";
const PAGE_ID      = "ceebb331d49c3b32c6a2";   // Safety Observations
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

  // Owned here, closed in the finally. Previously closed only at the end of the
  // success path, so any throw above it — load timeout, SSO bounce, a capture
  // that never arrived — orphaned the tab. These sources poll, and the tabs are
  // not registered with shared/tabSessions.js, so the idle reaper cannot see
  // them either: nothing was cleaning them up.
  try {
    return await runFetchRecognition(tab, didOpen, storeNbr);
  } finally {
    // Only ours. A tab the user already had open stays open.
    if (didOpen) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runFetchRecognition(tab, didOpen, storeNbr) {

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
    const replayResult = await replayInTab(tabId, cap.url, newBody, cap.reqHeaders);
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

  // The visual we capture is hard-filtered to one half of the data:
  //   Is_this_safety_observation_engagement_or_recognition IN ('Recognition')
  // Engagements are the other half and have no visual of their own on this
  // page, so the only way to get them is to replay the same query with the
  // type literal swapped. Best-effort: a store has safety observations either
  // way, and losing engagements shouldn't fail the whole pull.
  const engagementBody = swapObservationType(replay ? swapStoreFilter(cap.reqBody, requested) : cap.reqBody, "Engagement");
  let engagementRows = [];
  if (engagementBody) {
    const engResult = await replayInTab(tabId, cap.url, engagementBody, cap.reqHeaders);
    if (engResult.ok) {
      engagementRows = decodeRecognitionResponse(engResult.body);
    } else {
      console.log(`[livedashboard recognition] engagement replay failed (${engResult.status ?? engResult.error}) — recognition-only this pull`);
    }
  }

  const importedAt = new Date().toISOString();

  // We're done with the tab. Only close it if WE opened it — leave alone
  // any pre-existing Power BI tab the user might still be using.
  // NOT closed here — fetchRecognition's finally owns the tab.

  return {
    ok: true,
    rows,
    engagementRows,
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

// Replaying a QES query has two hard requirements, both learned the hard way
// (verified against the live endpoint 2026-08-31):
//
//   credentials: "omit"  — the QES host is cross-origin from app.powerbi.com
//     and answers preflight without Access-Control-Allow-Credentials. Sending
//     "include" makes the browser reject the response before we see it, which
//     surfaces as an opaque `TypeError: Failed to fetch`. This is exactly what
//     register.js has been dying of since 2026-08-12.
//   the captured request headers — QES authenticates on the Authorization
//     bearer the SPA minted, NOT on cookies. Omit them and it's a flat 401.
//
// Both together: 200. Either alone: broken. Don't "simplify" this.
async function replayInTab(tabId, url, body, reqHeaders) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [url, body, reqHeaders || null, "__APAISUITE_LIVEDASHBOARD_RECOGNITION_CAP"],
      func:   async (u, b, h, capKey) => {
        try {
          // Pre-patch fetch, so this replay isn't recorded into our own ring.
          const send = window[capKey]?.rawFetch || fetch;
          const r = await send(u, {
            method:      "POST",
            credentials: "omit",
            headers:     h || { "Content-Type": "application/json;charset=UTF-8", "Accept": "application/json" },
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

// The observation-type Where clause, e.g.
//   "Property":"Is_this_safety_observation_engagement_or_recognition" … "Value":"'Recognition'"
// Returns null when the clause isn't present, so the caller can skip the
// engagement replay instead of POSTing an unmodified (duplicate) query.
const OBSERVATION_TYPE_RE =
  /("Property":"Is_this_safety_observation_engagement_or_recognition"[\s\S]{0,400}?"Value":")'[^']*'(")/g;

function swapObservationType(body, type) {
  if (typeof body !== "string") return null;
  OBSERVATION_TYPE_RE.lastIndex = 0;
  if (!OBSERVATION_TYPE_RE.test(body)) return null;
  OBSERVATION_TYPE_RE.lastIndex = 0;
  return body.replace(OBSERVATION_TYPE_RE, `$1'${type}'$2`);
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
