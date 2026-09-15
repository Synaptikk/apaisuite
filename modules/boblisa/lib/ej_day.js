// modules/boblisa/lib/ej_day.js
//
// One whole EJ store-day, fetched AND analyzed inside an ej.walmart.com tab.
// registerls' fetchReceipts returns raw records to the service worker, which
// is fine for one register (~150 receipts) and hangs for a store-day (~8,000,
// ~12 MB through executeScript's result channel). So: inject the bridge
// (content/ej_day_bridge.js → globalThis.__boblisa), then run the fetch in
// the page and hand back only lib/pairs.js::analyzeDay's output.
//
// Auth classification mirrors registerls/lib/ej.js so the view can show the
// same "open EJ Viewer and sign in" recovery.
//
// The tab is always a FRESH one (openEjDayTab), never a reused ej.walmart.com
// tab: Edge freezes background tabs after a few idle minutes and
// executeScript into a frozen tab never resolves (found 2026-09-14 —
// registerls' openEjSession reuses whatever tab exists and is exposed to the
// same hang). ensureAwake() reloads the tab if it froze between days.

import { classifyAuthResponse, isAuthFailureStatus } from "../../../shared/auth.js";
import { EJ_ORIGIN, EJ_HOME, ejReceiptsUrl, isoToEjDate } from "../../registerls/lib/ej.js";

const BRIDGE_FILE = "modules/boblisa/content/ej_day_bridge.js";
const SETTLE_MS = 1500;   // let the SPA refresh its own PingFed tokens before we ask

function waitForComplete(tabId, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

/** A new, inactive ej.walmart.com tab for one pull; close() when done. */
export async function openEjDayTab() {
  const tab = await chrome.tabs.create({ url: EJ_HOME, active: false });
  await waitForComplete(tab.id);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return { tabId: tab.id, close: () => chrome.tabs.remove(tab.id).catch(() => {}) };
}

/** Frozen / discarded tabs swallow executeScript forever — reload and wait instead. */
async function ensureAwake(tabId) {
  const t = await chrome.tabs.get(tabId);
  if (!t.frozen && !t.discarded) return;
  await chrome.tabs.reload(tabId);
  await waitForComplete(tabId);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

// Serialized into the tab — no closures over module scope.
async function fetchAndAnalyzeInPage({ origin, url, currentDate, dateIso, opts }) {
  const out = { ok: false };
  try {
    for (let i = 0; i < 200 && !globalThis.__boblisa && !globalThis.__boblisaError; i++) await new Promise((r) => setTimeout(r, 50));
    if (!globalThis.__boblisa) { out.error = `analysis bridge not loaded${globalThis.__boblisaError ? `: ${globalThis.__boblisaError}` : ""}`; return out; }
    const t = await fetch(`${origin}/api/v1/isp-token`, { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
    const tText = await t.text();
    out.tokenStatus = t.status; out.tokenCt = t.headers.get("content-type") || ""; out.tokenHead = tText.slice(0, 300);
    let token = null;
    try { token = JSON.parse(tText)?.data?.ispToken || null; } catch {}
    if (!token) return out;
    const corr = (globalThis.crypto?.randomUUID?.()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = { "isp-token": token, currentDate, registerNumber: "", transactionNumber: "", operatorNumber: "", tcNumber: "", startTime: "", stopTime: "" };
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
    out.ok = true;
    out.day = globalThis.__boblisa.analyzeDay(json.records, dateIso, opts);
    return out;
  } catch (e) {
    out.error = String(e?.message || e);
    return out;
  }
}

function authFailed(res) {
  const a = classifyAuthResponse({ status: res.tokenStatus ?? res.status, contentType: res.tokenCt || res.ct || "", body: res.tokenHead || res.head || "" });
  return isAuthFailureStatus(a) || (res.tokenStatus === 200 && !res.ok && !res.status);
}

async function runInTab(tabId, args) {
  await ensureAwake(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] });
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: fetchAndAnalyzeInPage, args: [args] });
  return inj?.result || { ok: false, error: "no result from tab" };
}

/**
 * @param {string} storeNbr
 * @param {string} dateIso  YYYY-MM-DD business day
 * @param {{ session?: { tabId }, opts?: object }} o  `session` from openEjDayTab() (one tab for a whole range)
 * @returns {{ ok: true, day, fetchedAt, via } | { ok: false, errorClass, error, loginUrl? }}
 */
export async function fetchDayAnalysis(storeNbr, dateIso, { session = null, opts = undefined } = {}) {
  const args = { origin: EJ_ORIGIN, url: ejReceiptsUrl(storeNbr, dateIso), currentDate: isoToEjDate(new Date().toISOString().slice(0, 10)), dateIso, opts };
  let res;
  let own = null;
  if (!session?.tabId) { try { own = await openEjDayTab(); } catch (e) { res = { ok: false, error: `EJ tab failed: ${e?.message || e}` }; } }
  const tabId = session?.tabId || own?.tabId;
  if (tabId) {
    try { res = await runInTab(tabId, args); } catch (e) { res = { ok: false, error: `EJ tab failed: ${e?.message || e}` }; }
  }
  await own?.close?.();
  if (!res.ok) {
    if (authFailed(res)) return { ok: false, errorClass: "AUTH", error: "EJ Viewer session expired — open ej.walmart.com, complete SSO, then pull again.", loginUrl: EJ_HOME };
    return { ok: false, errorClass: res.status ? "HTTP" : "NETWORK", error: `EJ ${res.status ? `HTTP ${res.status}` : res.error || "failed"}${res.head ? ` — ${res.head.slice(0, 120)}` : ""}` };
  }
  return { ok: true, day: res.day, fetchedAt: new Date().toISOString(), via: "tab" };
}
