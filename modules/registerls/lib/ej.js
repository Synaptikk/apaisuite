// modules/registerls/lib/ej.js
//
// EJ Viewer (ej.walmart.com) — every printed receipt for one register on one
// business day. Wire shape in dev/REGISTER_LS_FINDINGS.md §2:
//   GET  /api/v1/isp-token                      → data.ispToken (bearer, ~1h)
//   POST /api/v1/receipts/US/<site>/<MM-DD-YYYY>  body { "isp-token", currentDate, registerNumber, … }
//        + header correlation-id (mandatory)   → { records: [...] }
//
// Tried from the service worker first (cookies ride along with
// credentials:"include" thanks to the ej.walmart.com host permission). If
// that comes back as an auth failure, the same two calls are run inside a
// background ej.walmart.com tab, where the page's own session applies; the
// tab is closed again unless the user already had one open.

import { classifyAuthResponse, isAuthFailureStatus } from "../../../shared/auth.js";
import { withTempTab, findOrOpenTracked, closeIfOpened } from "../../../shared/tabs.js";

export const EJ_ORIGIN = "https://ej.walmart.com";
export const EJ_HOME   = `${EJ_ORIGIN}/`;

// "2026-08-16" → "08-16-2026"
export function isoToEjDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}-${m[1]}` : null;
}

export function ejReceiptsUrl(site, dateIso, country = "US") {
  return `${EJ_ORIGIN}/api/v1/receipts/${country}/${site}/${isoToEjDate(dateIso)}`;
}

export function buildReceiptsBody(token, { registerNumber = "", operatorNumber = "", transactionNumber = "", tcNumber = "", startTime = "", stopTime = "", now = new Date() } = {}) {
  return {
    "isp-token": token,
    currentDate: isoToEjDate(now.toISOString().slice(0, 10)),
    registerNumber: String(registerNumber || ""),
    transactionNumber: String(transactionNumber || ""),
    operatorNumber: String(operatorNumber || ""),
    tcNumber: String(tcNumber || ""),
    startTime: String(startTime || ""),
    stopTime: String(stopTime || ""),
  };
}

// The two-call sequence, written so it can run either in the SW (called
// directly) or inside a tab (serialised by chrome.scripting.executeScript —
// hence no closures over module scope).
async function pullReceipts({ origin, url, registerNumber, currentDate, operatorNumber = "" }) {
  const out = { ok: false };
  try {
    const t = await fetch(`${origin}/api/v1/isp-token`, { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
    const tText = await t.text();
    out.tokenStatus = t.status; out.tokenCt = t.headers.get("content-type") || ""; out.tokenHead = tText.slice(0, 300);
    let token = null;
    try { token = JSON.parse(tText)?.data?.ispToken || null; } catch {}
    if (!token) return out;
    const corr = (globalThis.crypto?.randomUUID?.()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = { "isp-token": token, currentDate, registerNumber, transactionNumber: "", operatorNumber: String(operatorNumber || ""), tcNumber: "", startTime: "", stopTime: "" };
    const r = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", "correlation-id": corr },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    out.status = r.status; out.ct = r.headers.get("content-type") || ""; out.head = text.slice(0, 300);
    if (!r.ok) return out;
    const json = JSON.parse(text);
    if (!Array.isArray(json?.records)) { out.error = "EJ response missing records array"; return out; }
    out.ok = true; out.records = json.records;
    return out;
  } catch (e) {
    out.error = String(e?.message || e);
    return out;
  }
}

function authFailed(res) {
  const a = classifyAuthResponse({ status: res.tokenStatus ?? res.status, contentType: res.tokenCt || res.ct || "", body: res.tokenHead || res.head || "" });
  return isAuthFailureStatus(a) || (res.tokenStatus === 200 && !res.ok && !res.status) /* token JSON without ispToken → not signed in */;
}

// The SW path fails on auth in practice (the EJ session cookie is scoped to
// the page); once it has failed, skip straight to the tab for a while
// instead of paying the failed round trip on every item.
let swAuthFailedUntil = 0;
const SW_SKIP_MS = 15 * 60_000;

// One background ej.walmart.com tab shared by a whole analysis run: opening
// the SPA costs ~4 s, a receipts call inside it ~0.5 s. `close()` leaves a
// tab alone if the user already had it open.
export async function openEjSession() {
  const state = await findOrOpenTracked(EJ_HOME, { active: false });
  await waitForComplete(state.tab.id, 20_000);
  await new Promise((r) => setTimeout(r, 1500));
  return { tabId: state.tab.id, close: () => closeIfOpened(state) };
}

async function pullInTab(tabId, args) {
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: pullReceipts, args: [args] });
  return inj?.result || { ok: false, error: "no result from tab" };
}

// `operatorNumber` narrows the day to one operator (registerNbr "" = every
// register): ~75 records / 2.5 s for a cashier-day, banners included — how
// boblisa names an operator APPRISS has no drawer open for (2026-09-16).
export async function fetchReceipts(site, dateIso, registerNbr, { allowTabFallback = true, session = null, operatorNumber = "" } = {}) {
  const args = {
    origin: EJ_ORIGIN,
    url: ejReceiptsUrl(site, dateIso),
    registerNumber: String(registerNbr || ""),
    operatorNumber: String(operatorNumber || ""),
    currentDate: isoToEjDate(new Date().toISOString().slice(0, 10)),
  };
  let res, via;
  if (session?.tabId) {
    via = "tab";
    try { res = await pullInTab(session.tabId, args); } catch (e) { res = { ok: false, error: `EJ session tab failed: ${e?.message || e}` }; }
  } else if (Date.now() < swAuthFailedUntil) {
    res = { ok: false, error: "sw path skipped (recent auth failure)" }; via = "sw";
  } else {
    res = await pullReceipts(args); via = "sw";
    if (!res.ok && authFailed(res)) swAuthFailedUntil = Date.now() + SW_SKIP_MS;
  }
  if (!res.ok && !session?.tabId && allowTabFallback && (authFailed(res) || res.error)) {
    via = "tab";
    try {
      res = await withTempTab(EJ_HOME, async (tab) => {
        // Let the SPA finish its own token refresh before we ask.
        await waitForComplete(tab.id, 20_000);
        await new Promise((r) => setTimeout(r, 1500));
        return pullInTab(tab.id, args);
      }, { active: false });
    } catch (e) {
      res = { ok: false, error: `EJ tab fallback failed: ${e?.message || e}` };
    }
  }
  if (!res.ok) {
    if (authFailed(res)) {
      return { ok: false, errorClass: "AUTH", error: "EJ Viewer session expired — open ej.walmart.com, complete SSO, then retry.", loginUrl: EJ_HOME, via };
    }
    return { ok: false, errorClass: res.status ? "HTTP" : "NETWORK", error: `EJ ${res.status ? `HTTP ${res.status}` : res.error || "failed"}${res.head ? ` — ${res.head.slice(0, 120)}` : ""}`, via };
  }
  return { ok: true, records: res.records, fetchedAt: new Date().toISOString(), via, site: String(site), date: dateIso, register: String(registerNbr || "") };
}

async function waitForComplete(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
