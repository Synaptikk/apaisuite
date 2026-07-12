// modules/livedashboard/lib/sources/compliance.js
//
// Compliance source (Enviance). Capture-and-replay pattern:
//   1. The MAIN-world content script (modules/livedashboard/content/
//      enviance_capture.js) monkey-patches fetch+XHR on go.enviance.com
//      and ring-buffers WfAdapt.getWfs request envelopes.
//   2. This module's pull handler finds/opens a background Enviance tab,
//      waits for the capture, reads it via chrome.scripting.executeScript
//      ({ world: "MAIN" }), and replays the request from the SW (or, if
//      replay fails on auth, decodes the captured response body directly
//      — fastest fallback since the bootstrap call already returned).
//
// See dev/ENVIANCE_FINDINGS.md for the endpoint contract.

import { classifyAuthResponse, isAuthFailureStatus, reloadTabAndWait } from "../../../../shared/auth.js";

const ENVIANCE_TAB_PATTERN = "https://go.enviance.com/CustomApp/*";
const ENVIANCE_DEFAULT_URL = "https://go.enviance.com/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/index.html?SystemID=774d2e17-a8fc-409f-9480-e3fa9310c1c5#/panel/cd2f57ae-5625-4762-8f88-1d47d915cc54/false";
const CAPTURE_WAIT_MS      = 15_000;   // SPA bootstrap typically fires within 10s
const CAPTURE_POLL_MS      = 500;

// Autonomous-reauth attempts when the replay or cached body classifies
// as an Enviance login/SSO response. Each attempt reloads the tab (which
// triggers the SPA's auth bootstrap, usually silent if the SAML/AAD
// session is still cached), waits for a fresh capture, and re-replays.
const MAX_REAUTH_ATTEMPTS  = 2;

export async function fetchCompliance() {
  // 1. Find or open background tab.
  const opened = await findOrOpenEnvianceTab();
  if (!opened) return { ok: false, errorClass: "TAB", error: "Could not find or open Enviance tab." };
  const { tab, didOpen } = opened;

  // 2. Wait for tab to finish loading.
  await waitForTabLoad(tab.id, 20_000);

  // 3. Pipeline: get capture → classify body → decode rows. Wrap in an
  // autonomous-reauth loop matching the bounded-condition style used in
  // register.js / recognition.js: re-run after a tab reload as long as
  // the failure classifies as AUTH and we have retries left. Most
  // Enviance auth misses are a sleeping SAML cookie that re-validates
  // silently on reload.
  let result = await runCompliancePipeline(tab.id);
  let reauthAttempts = 0;
  while (result && !result.ok && result.errorClass === "AUTH" && reauthAttempts < MAX_REAUTH_ATTEMPTS) {
    reauthAttempts++;
    console.log(`[livedashboard compliance] auth-shaped response; reloading tab (autonomous reauth ${reauthAttempts}/${MAX_REAUTH_ATTEMPTS})`);
    const reloaded = await reloadTabAndWait(tab.id, {
      settleMs: 3000,
      timeoutMs: 30_000,
      // The capture ring buffer is reset by the page reload; readiness
      // here is just "tab back on the Enviance origin and complete".
      waitForReady: async (tabId) => {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        return !!t?.url && t.url.includes("go.enviance.com") && t.status === "complete";
      },
    });
    if (!reloaded.ok) {
      console.log(`[livedashboard compliance] reauth reload failed: ${reloaded.reason}`);
      break;
    }
    result = await runCompliancePipeline(tab.id);
  }

  // 4. Done with the tab. Only close it if WE opened it — leave alone any
  // pre-existing Enviance tab the user might be working in (e.g., opened
  // via the drill-down's focus_enviance_tab handler).
  if (didOpen) {
    chrome.tabs.remove(tab.id).catch(() => { /* may already be gone */ });
  }

  // Annotate the result so the view can show how many silent retries
  // happened — useful for diagnostics but not surfaced as user-facing UI.
  if (reauthAttempts > 0 && result && typeof result === "object") {
    result.reauthAttempts = reauthAttempts;
  }
  return result;
}

// Run the get-capture → replay-if-stale → classify → decode pipeline once
// against a tab. Returns the same { ok, rows, ... } | { ok:false, errorClass, ... }
// shape fetchCompliance always has, plus an `errorClass: "AUTH"` for auth-
// shaped responses so the outer loop knows when to attempt reauth.
async function runCompliancePipeline(tabId) {
  const envelope = await pollForCapture(tabId, CAPTURE_WAIT_MS, CAPTURE_POLL_MS);
  if (!envelope) {
    return {
      ok: false, errorClass: "NO_CAPTURE",
      error: "Enviance tab open but WfAdapt.getWfs not captured in time. Open the panel manually once.",
    };
  }

  // We have the response body in the capture envelope (just-completed
  // bootstrap call), so we don't need to re-fetch unless it's stale. If
  // respBody is missing, replay; otherwise use it directly.
  let respText = envelope.respBody;
  let respStatus = 200;          // captured envelopes are post-success
  let respContentType = "application/json";
  let replayed = false;
  const captureAgeMs = Date.now() - (envelope.capturedAt || 0);

  // Replay if either: respBody missing, OR capture is older than 5 min.
  if (!respText || captureAgeMs > 5 * 60_000) {
    const replay = await replayInTab(tabId, envelope);
    if (replay.ok) {
      respText        = replay.body;
      respStatus      = replay.status ?? 200;
      respContentType = replay.contentType || respContentType;
      replayed        = true;
    } else if (replay.status) {
      // Replay returned a non-OK HTTP status — capture it for auth
      // classification even though we'll fall back to the cached body.
      respStatus      = replay.status;
      respContentType = replay.contentType || respContentType;
    }
    // If replay failed and we have any captured respBody, fall back to it.
    if (!respText && envelope.respBody) respText = envelope.respBody;
  }
  if (!respText) {
    return { ok: false, errorClass: "EMPTY", error: "No response body to decode." };
  }

  // Auth check BEFORE JSON.parse. If Enviance served a login HTML body
  // (status 200 + HTML), the parser would throw a confusing PARSE error.
  // The outer fetchCompliance loop catches errorClass:"AUTH" and triggers
  // a tab reload before deciding to give up.
  const authStatus = classifyAuthResponse({
    status: respStatus,
    contentType: respContentType,
    body: respText,
  });
  if (isAuthFailureStatus(authStatus)) {
    return {
      ok: false,
      errorClass: "AUTH",
      authStatus,
      error: `Enviance auth-shaped response (${authStatus}) — autonomous reauth will retry.`,
    };
  }

  // Parse rows.
  let json;
  try { json = JSON.parse(respText); }
  catch { return { ok: false, errorClass: "PARSE", error: "Response was not JSON." }; }

  const rows = decodeWfsResponse(json);
  return {
    ok:         true,
    rows,
    fromReplay: replayed,
    capturedAt: new Date(envelope.capturedAt || Date.now()).toISOString(),
    captureAgeMs,
  };
}

async function findOrOpenEnvianceTab() {
  const existing = await chrome.tabs.query({ url: ENVIANCE_TAB_PATTERN });
  if (existing.length) return { tab: existing[0], didOpen: false };
  const tab = await chrome.tabs.create({ url: ENVIANCE_DEFAULT_URL, active: false });
  return tab ? { tab, didOpen: true } : null;
}

async function waitForTabLoad(tabId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 200));
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

async function readCapture(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func:   () => {
        const cap = window.__APAISUITE_LIVEDASHBOARD_ENV_CAP;
        if (!cap) return null;
        return cap.findCompliance();
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

// Replay the captured POST from INSIDE the tab (not from the SW). This
// avoids cross-origin cookie / SameSite issues entirely — the request
// runs in the same origin as the page, so the Enviance session cookies
// carry naturally.
async function replayInTab(tabId, envelope) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      args:   [envelope.url, envelope.reqBody],
      func:   async (url, body) => {
        try {
          const r = await fetch(url, {
            method:      "POST",
            credentials: "include",
            headers:     { "Content-Type": "application/x-www-form-urlencoded" },
            body,
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
    const out = results?.[0]?.result;
    if (!out) return { ok: false };
    return out;
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Decode the WfAdapt.getWfs response into ComplianceTask[]. The response
// shape is documented in dev/ENVIANCE_FINDINGS.md — an array of result
// blocks, each with `columns` (positional schema) and `rows` (array of
// {values: [...]} entries).
export function decodeWfsResponse(json) {
  // Response is an array; the first element has the tasks.
  const block = Array.isArray(json) ? json[0] : json?.[0] || json;
  if (!block?.columns || !block?.rows) return [];
  const cols = block.columns.map((c) => c.name);
  const idx  = Object.fromEntries(cols.map((c, i) => [c, i]));
  const out  = [];
  for (const r of block.rows) {
    const v = r?.values;
    if (!Array.isArray(v)) continue;
    const facilityRaw = v[idx.Poi_P_Name] ?? "";
    const facility    = String(facilityRaw).replace(/^Facility\s+/i, "");
    const dueRaw      = v[idx.Workflow_WFI_DueDate] ?? null;
    const due         = parseDueDate(dueRaw);
    out.push({
      id:           v[idx.id] ?? null,
      taskName:     v[idx.name] ?? "",
      facility,
      facilityRaw:  facilityRaw || null,
      dueAt:        due.iso,
      dueDate:      due.date,
      daysUntilDue: due.daysUntilDue,
      isOverdue:    due.isOverdue,
      isDueSoon:    due.isDueSoon,
      category:     inferCategory(v[idx.name] ?? ""),
      primaryStatus: v[idx.primaryStatus] ?? null,
    });
  }
  // Sort: overdue first (most overdue at top), then due soon, then rest.
  out.sort((a, b) => {
    if (a.daysUntilDue == null && b.daysUntilDue == null) return 0;
    if (a.daysUntilDue == null) return 1;
    if (b.daysUntilDue == null) return -1;
    return a.daysUntilDue - b.daysUntilDue;
  });
  return out;
}

function parseDueDate(raw) {
  if (!raw) return { iso: null, date: null, daysUntilDue: null, isOverdue: false, isDueSoon: false };
  // Enviance returns "2026-06-05T03:45:00" (no timezone). Treat as UTC for
  // computation; days-until-due is a date comparison, not a precise hour
  // comparison, so this is fine.
  const d = new Date(raw + (raw.endsWith("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return { iso: raw, date: null, daysUntilDue: null, isOverdue: false, isDueSoon: false };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dueDay = new Date(d);
  dueDay.setUTCHours(0, 0, 0, 0);
  const days = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);
  return {
    iso:          d.toISOString(),
    date:         d.toISOString().slice(0, 10),
    daysUntilDue: days,
    isOverdue:    days < 0,
    // "Due soon" surfaces tasks the user should act on this week.
    // Threshold tuned by user feedback: 5 days catches anything due
    // through end of work week without flooding with month-out items.
    isDueSoon:    days >= 0 && days <= 5,
  };
}

function inferCategory(name) {
  const n = String(name).toLowerCase();
  if (n.startsWith("weekly "))                       return "weekly";
  if (n.startsWith("monthly "))                      return "monthly";
  if (n.startsWith("annual ") || n.startsWith("yearly ")) return "annual";
  return "unknown";
}

export function rollup(tasks) {
  let overdue = 0;
  let dueSoon = 0;
  let worstOverdueDays = 0;
  for (const t of tasks) {
    if (t.isOverdue) {
      overdue++;
      if (-t.daysUntilDue > worstOverdueDays) worstOverdueDays = -t.daysUntilDue;
    } else if (t.isDueSoon) {
      dueSoon++;
    }
  }
  return { overdue, dueSoon, worstOverdueDays, total: tasks.length };
}
