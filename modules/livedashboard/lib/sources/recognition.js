// modules/livedashboard/lib/sources/recognition.js
//
// Safety Observations — Recognition and Engagement counts from the
// Field_Dashboard Power BI report, feeding the rolling 7-day breakdown in the
// Accident Details drill-down.
//
// We BUILD the query (shared/pbi_query.js) instead of replaying the one the
// report fired. Measured live 2026-09-15, the report's own query carried:
//   - the viewer's saved store ('01458') — the old code only swapped it by
//     regex, and decoded the saved response verbatim when it matched;
//   - a store-tier slicer (tier_status_FY27_period IN G1/G2/G3) — a store
//     outside those tiers would silently get nothing;
//   - a 500-row window — the saved response was exactly 500 rows (Jun 15 →
//     Sep 14), i.e. already at the cap;
//   - grouping by (store, date, description) with no count — Engagements have
//     no description, so every engagement on a day collapsed into ONE row.
//     Store 01458 showed 9 engagements in 14 days; the real number is 32
//     (01215: 14 vs 57). Recognitions were unaffected (86 = 86).
// The built query filters only on store, observation type and a 14-day date
// floor, asks for the full row window, checks completeness, and counts the
// never-empty type column per group so merged rows expand back to real
// observations.
//
// The capture (content/powerbi_recognition_capture.js) is still needed, but
// only for TRANSPORT: the QES url, the request headers (MWCToken) and the
// modelId. Pipeline:
//   1. Find/open a background Field_Dashboard tab.
//   2. Wait for any captured Recognition QES request carrying auth.
//   3. POST our query in-tab (see replayInTab for why in-tab + omit creds).
//   4. Decode, expand merged groups, return rows; rollup7d() buckets by day.

import { classifyAuthResponse, isAuthFailureStatus, reloadTabAndWait } from "../../../../shared/auth.js";
import {
  AGG, MAX_WINDOW, aggregate, buildQuery, column, decodeRows, pickTransport,
  readResult, whereDateRange, whereIn,
} from "../../../../shared/pbi_query.js";

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

const CAPTURE_KEY     = "__APAISUITE_LIVEDASHBOARD_RECOGNITION_CAP";
const CAPTURE_WAIT_MS = 25_000;
const CAPTURE_POLL_MS = 600;
const MAX_REAUTH_ATTEMPTS = 2;
const LOOKBACK_DAYS   = 14;   // rollup7d shows 7; the margin covers late-posted observations

// Model names (verified 2026-09-15, model 3360717).
const ENTITY_SURVEY = "High Accidents Survey";
const FROM = [
  { Name: "s", Entity: "Stores Master" },
  { Name: "c", Entity: "Calendar" },
  { Name: "h", Entity: ENTITY_SURVEY },
];
const TYPE_PROP = "Is_this_safety_observation_engagement_or_recognition";

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
    return await runFetchRecognition(tab, storeNbr);
  } finally {
    // Only ours. A tab the user already had open stays open.
    if (didOpen) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runFetchRecognition(tab, storeNbr) {
  await waitForTabLoad(tab.id, 25_000);

  // After an extension reload, an existing tab's document_start content
  // scripts didn't run on the already-loaded page — reload so it re-injects.
  const installed = await isCaptureInstalled(tab.id);
  if (!installed) {
    await chrome.tabs.reload(tab.id, { bypassCache: false });
    await waitForTabLoad(tab.id, 25_000);
  }

  let result = await runRecognitionPipeline(tab.id, storeNbr);
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
    result = await runRecognitionPipeline(tab.id, storeNbr);
  }

  if (reauthAttempts > 0 && result && typeof result === "object") {
    result.reauthAttempts = reauthAttempts;
  }
  return result;
}

async function runRecognitionPipeline(tabId, storeNbr) {
  const transport = await pollForTransport(tabId, CAPTURE_WAIT_MS, CAPTURE_POLL_MS);
  if (!transport) {
    return {
      ok: false, errorClass: "NO_CAPTURE",
      error: "No Power BI request captured from the Safety Observations page. Open it once manually so the report signs in and fires its queries.",
    };
  }

  const requested = padStore(storeNbr);
  const since = isoDaysAgo(LOOKBACK_DAYS);

  const recognition = await queryObservations(tabId, transport, requested, "Recognition", since);
  if (!recognition.ok) return recognition;

  // Engagements are secondary: a failure there must not fail the whole pull.
  const engagement = await queryObservations(tabId, transport, requested, "Engagement", since);
  if (!engagement.ok) {
    if (engagement.errorClass === "AUTH") return engagement;
    console.log(`[livedashboard recognition] engagement query failed (${engagement.errorClass}: ${engagement.error}) — recognition-only this pull`);
  }

  return {
    ok: true,
    rows: recognition.rows,
    engagementRows: engagement.ok ? engagement.rows : [],
    capturedAt:     new Date().toISOString(),
    capturedStore:  null,
    requestedStore: requested,
    replayed:       false,
    method:         "built-query",
    since,
  };
}

async function queryObservations(tabId, transport, store, type, since) {
  const body = buildObservationQuery({ modelId: transport.modelId, store, type, since });
  const res = await replayInTab(tabId, transport.url, JSON.stringify(body), transport.headers);

  const authStatus = classifyAuthResponse({
    status: res.status ?? (res.ok ? 200 : 0),
    contentType: res.contentType || "",
    body: res.body || "",
  });
  if (isAuthFailureStatus(authStatus)) {
    return {
      ok: false, errorClass: "AUTH", authStatus,
      error: `Power BI recognition query returned ${authStatus} — autonomous reauth will retry.`,
    };
  }
  if (!res.ok) {
    return { ok: false, errorClass: "QUERY", error: `Recognition ${type} query failed: ${res.error || res.status}` };
  }

  let json;
  try { json = JSON.parse(res.body); }
  catch { return { ok: false, errorClass: "PARSE", error: `Recognition ${type} response was not JSON.` }; }

  const { complete, error } = readResult(json);
  if (error) return { ok: false, errorClass: "QUERY", error: `Power BI rejected the ${type} query: ${error}` };
  if (!complete) {
    return {
      ok: false, errorClass: "TRUNCATED",
      error: `${type} observations for store ${store} exceeded ${MAX_WINDOW.toLocaleString("en-US")} rows; refusing a partial count.`,
    };
  }
  return { ok: true, rows: expandObservations(decodeRows(json)) };
}

// ── Query + row shaping (pure; exported for tests) ─────────────────

export function buildObservationQuery({ modelId, store, type, since }) {
  return buildQuery({
    modelId,
    from: FROM,
    select: [
      ["Store", column("s", "fascility_nbr_padded")],
      ["Date", column("c", "GREGORIAN_DATE")],
      ["Description", column("h", "Description_of_the_Safety_Observation")],
      // Count of a never-empty column per group. AGG.COUNT returned 1 per
      // group here; COUNT_NON_NULL returns the real number of observations.
      ["Count", aggregate("h", TYPE_PROP, AGG.COUNT_NON_NULL)],
    ],
    where: [
      whereIn(column("s", "fascility_nbr_padded"), [store]),
      whereIn(column("h", TYPE_PROP), [type]),
      whereDateRange(column("c", "GREGORIAN_DATE"), since),
    ],
  });
}

/** One output row per observation: a group with Count 3 becomes 3 rows. */
export function expandObservations(rows) {
  const out = [];
  for (const r of rows || []) {
    const dateIso = typeof r.Date === "number" ? epochToIsoDate(r.Date) : null;
    if (!dateIso) continue;
    const n = Math.max(1, Math.round(Number(r.Count) || 1));
    const row = { storeNbr: String(r.Store ?? ""), dateIso, description: String(r.Description ?? "") };
    for (let i = 0; i < n; i++) out.push({ ...row });
  }
  return out;
}

export function padStore(storeNbr) {
  const s = String(storeNbr || "").replace(/\D/g, "");
  return s.padStart(5, "0");
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

async function isCaptureInstalled(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [CAPTURE_KEY],
      func:   (k) => !!window[k],
    });
    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}

// Newest captured request that carries auth. Only descriptors cross the
// executeScript boundary — never the (large) response bodies.
async function pollForTransport(tabId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world:  "MAIN",
        args:   [CAPTURE_KEY],
        func:   (k) => {
          const cap = window[k];
          if (!cap) return null;
          return cap.all()
            .filter((e) => e.url && e.reqBody && (e.reqHeaders?.Authorization || e.reqHeaders?.authorization))
            .slice(-3)
            .map((e) => ({
              url: e.url,
              auth: e.reqHeaders.Authorization || e.reqHeaders.authorization,
              headers: e.reqHeaders,
              body: e.reqBody,
              capturedAt: e.capturedAt,
            }));
        },
      });
      const entries = results?.[0]?.result || [];
      const picked = pickTransport(entries, { entity: ENTITY_SURVEY });
      if (picked) {
        const entry = entries.find((e) => e.url === picked.url && e.auth === picked.auth) || {};
        return { ...picked, headers: entry.headers || { Authorization: picked.auth, "Content-Type": "application/json;charset=UTF-8" } };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

// Sending a QES query has two hard requirements, both learned the hard way
// (verified against the live endpoint 2026-08-31):
//
//   credentials: "omit"  — the QES host is cross-origin from app.powerbi.com
//     and answers preflight without Access-Control-Allow-Credentials. Sending
//     "include" makes the browser reject the response before we see it, which
//     surfaces as an opaque `TypeError: Failed to fetch`.
//   the captured request headers — QES authenticates on the Authorization
//     bearer the SPA minted, NOT on cookies. Omit them and it's a flat 401.
//
// Both together: 200. Either alone: broken. Don't "simplify" this.
async function replayInTab(tabId, url, body, reqHeaders) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [url, body, reqHeaders || null, CAPTURE_KEY],
      func:   async (u, b, h, capKey) => {
        try {
          // Pre-patch fetch, so our query isn't recorded into the ring.
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

// ── Dates + rolling 7-day rollup ───────────────────────────────────

function epochToIsoDate(ms) {
  if (typeof ms !== "number") return null;
  return new Date(ms).toISOString().slice(0, 10);
}

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

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
