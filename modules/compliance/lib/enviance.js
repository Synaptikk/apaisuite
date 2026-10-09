// modules/compliance/lib/enviance.js
//
// Talks to Enviance (go.enviance.com, Cority) from inside one of its own tabs.
// Two back ends, both reached with the user's SSO session:
//
//   EQL      POST /CustomApp/<pkg>/app/core/query-builder/query-template.eqlx
//            The compliance portal's own query endpoint. It runs whatever EQL
//            `eqlQuery` holds (read-only SELECTs), so the task list, the form
//            templates and the custom-field captions all come from here.
//            pageSize above 1000 fails with a bare "400 Internal error".
//   REST     https://api.enviance.com/ver2/WorkflowService.svc/...
//            Enviance's public API, authorised with "Enviance <sessionId>"
//            where the session id comes from the package BootStrap call.
//            POST workflows/steps          read keyed-in answers (bulk)
//            PATCH workflows/{id}/steps/currentstep
//                   { stepInfo: { fields:[{name, values}], transition? } }
//            The Workflow App Builder forms (EyeWashInspectionV2App etc.) use
//            exactly these calls; "Complete and Close" is the predefined
//            "End Workflow" transition. PUT/POST on that path answer 405.
//
// Requests run in the page (MAIN world) so Enviance's cookies ride along.
// Everything passed to executeScript must be serialisable and the page
// functions must not close over anything.

import { registerSessionTab, forgetSessionTab, touchSessionTab } from "../../../shared/tabSessions.js";

let report = () => {};
// service.js hands in its progress setter (status line on the page).
export function onProgress(fn) { report = fn; }

const MODULE_ID = "compliance";
const PACKAGE_ID = "ddde6520-3955-4d83-b0ab-78f6e5cbaf10";
const SYSTEM_ID = "774d2e17-a8fc-409f-9480-e3fa9310c1c5";
export const PORTAL_URL = `https://go.enviance.com/CustomApp/${PACKAGE_ID}/index.html?SystemID=${SYSTEM_ID}#/page/9108fa2b-5826-48eb-ac95-f5385de025a6`;
// A 1 KB file on the same origin. Opening it is enough to borrow the user's
// Enviance cookies; the portal (index.html) instead pulls ~1.6 MB of dashboard
// data before it is usable, which made every refresh 15-60+ s. The portal is
// only opened when the session has to be renewed through SSO.
const LIGHT_URL = `https://go.enviance.com/CustomApp/${PACKAGE_ID}/package.cfg`;

// The form app for one task, the same link the portal's task table opens.
export function taskUrl(appName, uniqueId, stepName) {
  if (!appName) return PORTAL_URL;
  return `https://go.enviance.com/goto/${SYSTEM_ID}/${appName}/?hash=/search/${encodeURIComponent(uniqueId)}/${encodeURIComponent(stepName || "")}`;
}

// Any loaded go.enviance.com page except its login hand-off works: pageRun
// only needs the origin's cookies.
const onPortal = (t) => !!t && t.status === "complete" && /^https:\/\/go\.enviance\.com\//.test(t.url || "") && !/\/Authentication\//i.test(t.url || "");
const SIGN_IN = "Enviance needs a sign-in in this browser: click Open Enviance, let it finish signing in, then Refresh.";

// A cold session loads index.html on go.enviance.com first, THEN the app's
// 401 bounces the tab through Login.aspx → walmart.enviance.com →
// pfedprod.wal-mart.com (SSO) → back. "complete" on the first load is
// therefore not ready: wait until the tab has sat on the portal for a few
// seconds. Running in the middle of the bounce fails with "Cannot access
// contents of the page" (pfedprod is not a host this extension may touch).
async function waitSettled(tabId, ms, quietMs = 4000) {
  const end = Date.now() + ms;
  let since = 0;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (onPortal(t)) { since ||= Date.now(); if (Date.now() - since >= quietMs) return true; }
    else since = 0;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// The tab left the portal while we were using it (SSO bounce, or the user
// navigated): wait for it to come back and run again, at most twice. Reads
// are safe to repeat; writeStep re-checks the task is still open first.
// For a tab we own, a dead session is renewed by sending it to the portal,
// whose app runs the SSO bounce and lands back on go.enviance.com.
async function withRetry(tabId, fn, owned = false) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(tabId); }
    catch (e) {
      if ((e.code !== "MOVED" && e.code !== "AUTH") || attempt >= 2) throw e;
      report(e.code === "AUTH" ? "Enviance login expired: signing in again through Walmart SSO" : "waiting for the Enviance tab to come back");
      if (owned && e.code === "AUTH") await chrome.tabs.update(tabId, { url: PORTAL_URL }).catch(() => {});
      if (!(await waitSettled(tabId, 90_000))) throw Object.assign(new Error(SIGN_IN), { code: "AUTH" });
    }
  }
}

// An Enviance portal tab: the user's own if one is open, else a background
// tab we open, register with the idle reaper and close in the finally.
// Always a fresh tab of our own. Borrowing one the user already had open hung
// in Edge: a portal tab left in the background gets put to sleep, and
// executeScript into a sleeping tab never answers. The light tab is cheap.
async function withEnvianceTab(fn) {
  report("opening a hidden Enviance tab");
  const tab = await chrome.tabs.create({ url: LIGHT_URL, active: false });
  // Edge's sleeping tabs freeze hidden tabs, and executeScript into a frozen
  // tab never settles (vizpick-tab-leak, 2026-09-15).
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await registerSessionTab(MODULE_ID, tab.id, { idleMs: 5 * 60_000 }).catch(() => {});
  try {
    if (!(await waitSettled(tab.id, 30_000, 300))) throw Object.assign(new Error(SIGN_IN), { code: "AUTH" });
    report("connected to Enviance");
    return await withRetry(tab.id, fn, true);
  } finally {
    await forgetSessionTab(tab.id).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function run(tabId, ops, timeoutMs = 90_000) {
  await touchSessionTab(tabId).catch(() => {});
  const timeout = new Promise((r) => setTimeout(() => r([{ result: { ok: false, error: "Enviance didn't respond. Click Open Enviance, then Refresh.", detail: `tab silent for ${timeoutMs / 1000} s` } }]), timeoutMs));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!onPortal(tab)) throw Object.assign(new Error("Enviance tab is not on the portal."), { code: "MOVED" });
  const exec = chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: pageRun, args: [PACKAGE_ID, ops] })
    .catch((e) => {
      const m = String(e?.message || e);
      // Tab navigated away mid-call (SSO bounce) or the frame was replaced.
      if (/cannot access|permission to access|frame with id|was removed|no frame|navigat/i.test(m)) throw Object.assign(new Error("Enviance tab moved during the call."), { code: "MOVED" });
      throw e;
    });
  const res = (await Promise.race([exec, timeout]))?.[0]?.result;
  if (!res) throw new Error("Enviance didn't respond. Click Open Enviance, then Refresh.");
  if (!res.ok && res.detail) console.warn("[compliance] Enviance call failed:", res.detail);
  if (!res.ok) throw Object.assign(new Error(res.error || "Enviance call failed."), { code: res.code });
  return res.results;
}

// One Enviance tab for a whole operation: fn(run), where
// run(ops) takes [{ eql: "SELECT …" } | { api: "ver2/…", method, body }] and
// resolves to one result per op, in order (EQL → row objects, REST → JSON).
export async function withEnviance(fn) {
  return withEnvianceTab((tabId) => fn((ops, opts = {}) => run(tabId, ops, opts.timeoutMs)));
}

// Runs in the Enviance page. Must stay self-contained.
async function pageRun(packageId, ops) {
  const EQL_URL = `${location.origin}/CustomApp/${packageId}/app/core/query-builder/query-template.eqlx?name=cd2f57ae-5625-4762-8f88-1d47d915cc54__WfAdapt.getWfs`;
  const looksLikeLogin = (t) => /<html|login|SAMLRequest/i.test(String(t).slice(0, 400));
  try {
    const bsRes = await fetch(`/Packages/Api/BootStrap.svc/2?packageId=${packageId}`, { credentials: "include" });
    const bsText = await bsRes.text();
    if (!bsRes.ok || looksLikeLogin(bsText)) return { ok: false, code: "AUTH", error: "Enviance session expired: reload the Enviance tab and sign in." };
    const bs = JSON.parse(bsText);
    // Signed out, BootStrap still answers 200 but without a session.
    if (!bs.sessionId) return { ok: false, code: "AUTH", error: "Enviance session expired: reload the Enviance tab and sign in." };
    const H = { Authorization: "Enviance " + bs.sessionId, "Content-Type": "application/json", "EnvApi-SystemId": bs.currentSystemId };
    const results = [];
    for (const op of ops) {
      if (op.eql != null) {
        const rows = [];
        for (let page = 1; page < 40; page++) {
          const r = await fetch(EQL_URL, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "eqlQueryParam=" + encodeURIComponent(JSON.stringify({ parameters: { eqlQuery: op.eql }, page, pageSize: 1000 })),
          });
          const t = await r.text();
          if (r.status === 401 || looksLikeLogin(t)) return { ok: false, code: "AUTH", error: "Enviance session expired: reload the Enviance tab and sign in." };
          if (!r.ok) return { ok: false, error: "Couldn't reach Enviance. Click Open Enviance, sign in, then Refresh.", detail: `EQL ${r.status}: ${t.slice(0, 200)}` };
          const block = JSON.parse(t)[0];
          const cols = block.columns.map((c) => c.name);
          for (const x of block.rows) rows.push(Object.fromEntries(cols.map((c, i) => [c, x.values[i]])));
          if (block.rows.length < 1000) break;
        }
        results.push(rows);
      } else {
        const r = await fetch(`${bs.apiUrl}/${op.api}`, { method: op.method || "GET", headers: H, body: op.body == null ? undefined : JSON.stringify(op.body) });
        const t = await r.text();
        let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
        if (!r.ok) return { ok: false, code: r.status === 401 ? "AUTH" : undefined, error: "Couldn't reach Enviance. Click Open Enviance, sign in, then Refresh.", detail: `${op.method || "GET"} ${op.api.split("?")[0]} → ${r.status}: ${(j && j.message) || t.slice(0, 200)}` };
        results.push(j);
      }
    }
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

export const eqlString = (s) => String(s).replace(/'/g, "''");
