// modules/registerls/lib/cash_recycler.js
//
// Power BI "Cash Recycler" report — every till check-in / check-out, cash
// advance, vault advance and pickup for a store, with the associate who did
// it. Recorded 2026-09-12 (dev/REGISTER_LS_FINDINGS.md §4):
//
//   entity Cash_Recycler: Store_Infor ("1458 - FORT OGLETHORPE, GA"),
//   Transaction_Date (epoch ms, midnight UTC), Transaction_Time ("01:05:13 PM"),
//   Register, Register_Desc, Associate_Name ("CDH00BJ CINDY CHRISTIAN"),
//   Action_Type (TILLCHECKIN | TILLCHECKOUT | TILLCHECKINOVERRIDE | ADVANCECASH |
//   VAULTFUNDADVANCECASH | CASHPICKUP), Payment_Amt, Cash_Amt.
//
// The report's own table query has no Where clause and a 500-row window.
// We capture it (content/powerbi_cash_recycler_capture.js), add
// Store_Infor-contains + Transaction_Date >= filters, widen the window and
// page with RestartTokens, then decode the DSR (detail rows sit in the second
// PH block under DM1; the first block is the subtotal).

import { decodeDsr } from "../../digitallocks/lib/dsrDecode.js";
import { withTempTab } from "../../../shared/tabs.js";
import { classifyAuthResponse, isAuthFailureStatus } from "../../../shared/auth.js";

export const REPORT_ID  = "59fc9ae6-9d65-4277-b2f6-79fe4b5a10a4";
export const REPORT_URL = `https://app.powerbi.com/reportEmbed?reportId=${REPORT_ID}&autoAuth=true&ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d`;
const CAP_KEY = "__APAISUITE_REGISTERLS_CR_CAP";
const WINDOW_COUNT = 5000;
const MAX_PAGES = 8;

// ── Pure: query rewrite ────────────────────────────────────────────

export function buildFilteredBody(capturedBody, storeNbr, fromIso, { count = WINDOW_COUNT, restartTokens = null } = {}) {
  const j = JSON.parse(capturedBody);
  const q = j.queries?.[0];
  const cmd = q?.Query?.Commands?.[0]?.SemanticQueryDataShapeCommand;
  if (!cmd) throw new Error("not a SemanticQueryDataShapeCommand body");
  const src = cmd.Query.From?.[0]?.Name || "c";
  const col = (prop) => ({ Column: { Expression: { SourceRef: { Source: src } }, Property: prop } });
  cmd.Query.Where = [
    { Condition: { Contains: { Left: col("Store_Infor"), Right: { Literal: { Value: `'${String(storeNbr)}'` } } } } },
    { Condition: { Comparison: { ComparisonKind: 2, Left: col("Transaction_Date"), Right: { Literal: { Value: `datetime'${fromIso}T00:00:00'` } } } } },
  ];
  cmd.Binding = cmd.Binding || {};
  cmd.Binding.DataReduction = cmd.Binding.DataReduction || { DataVolume: 3, Primary: {} };
  cmd.Binding.DataReduction.Primary = { Window: restartTokens ? { Count: count, RestartTokens: restartTokens } : { Count: count } };
  delete q.CacheKey;
  return JSON.stringify(j);
}

// ── Pure: decode ───────────────────────────────────────────────────

const MONEY_RE = /^Sum\(Cash_Recycler\.(Payment_Amt|Cash_Amt)\)$/;

export function decodeCashRecycler(dataBlock) {
  const ds = dataBlock?.dsr?.DS?.[0];
  if (!ds) return { rows: [], restartTokens: null };
  // Detail rows: the PH block whose entries carry G-keys (not the A0/A1 subtotal).
  let detail = null;
  for (const ph of ds.PH || []) for (const [k, v] of Object.entries(ph)) {
    if (Array.isArray(v) && v.length && v[0]?.S?.some((s) => /^G/.test(s.N))) { detail = v; break; }
    if (detail) break;
  }
  if (!detail) return { rows: [], restartTokens: ds.RT || null };
  const raw = decodeDsr({ descriptor: dataBlock.descriptor, dsr: { DS: [{ ...ds, PH: [{ DM0: detail }] }] } });
  const rows = raw.map(normalizeRow).filter(Boolean);
  return { rows, restartTokens: ds.RT || null };
}

export function normalizeRow(r) {
  const get = (k) => r[k] ?? r[Object.keys(r).find((x) => MONEY_RE.test(x) && x.includes(k)) || ""];
  const dateMs = r.Transaction_Date;
  if (typeof dateMs !== "number") return null;
  const date = new Date(dateMs).toISOString().slice(0, 10);
  const time = String(r.Transaction_Time || "");
  const assoc = String(r.Associate_Name || "").trim();
  const sp = assoc.indexOf(" ");
  return {
    store:        String(r.Store_Infor || "").match(/^\d+/)?.[0] || "",
    date, time, timeInt: timeToInt(time),
    register:     r.Register == null ? "" : String(r.Register),
    registerDesc: String(r.Register_Desc || ""),
    associateId:  sp > 0 ? assoc.slice(0, sp) : assoc,
    associate:    sp > 0 ? assoc.slice(sp + 1) : "",
    action:       String(r.Action_Type || "").toUpperCase(),
    amountCents:  Math.round(Number(get("Payment_Amt") || 0) * 100),
    cashLsCents:  Math.round(Number(get("Cash_Amt") || 0) * 100),
  };
}

// "01:05:13 PM" → 130513 (HHMMSS, 24h)
export function timeToInt(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[4]) { const pm = m[4].toUpperCase() === "PM"; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return h * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
}

// ── Service worker: capture → replay → decode ──────────────────────

async function readCapture(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", args: [CAP_KEY], func: (k) => { const c = window[k]; return c ? c.findTable() : null; } });
    return r?.result || null;
  } catch { return null; }
}

async function replayInTab(tabId, url, body, headers) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", args: [url, body, headers || null, CAP_KEY],
      func: async (u, b, h, k) => {
        try {
          const send = window[k]?.rawFetch || fetch;
          const res = await send(u, { method: "POST", credentials: "omit", headers: h || { "Content-Type": "application/json;charset=UTF-8", Accept: "application/json" }, body: b });
          const text = await res.text().catch(() => "");
          return { ok: res.ok, status: res.status, contentType: res.headers.get("content-type") || "", body: text };
        } catch (e) { return { ok: false, status: 0, error: String(e?.message ?? e) }; }
      },
    });
    return r?.result || { ok: false };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

async function waitForComplete(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = await chrome.tabs.get(tabId).catch(() => null); if (!t) return false; if (t.status === "complete") return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

export async function fetchCashRecycler(storeNbr, { days = 60, onProgress } = {}) {
  const fromIso = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return withTempTab(REPORT_URL, async (tab) => {
    await waitForComplete(tab.id, 30_000);
    let cap = null;
    for (let i = 0; i < 60 && !cap; i++) { cap = await readCapture(tab.id); if (!cap) await new Promise((r) => setTimeout(r, 500)); }
    if (!cap) return { ok: false, errorClass: "NO_CAPTURE", error: "Cash Recycler table query not captured — open the report once by hand so it renders, then retry.", loginUrl: REPORT_URL };
    const rows = [];
    let restart = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = buildFilteredBody(cap.reqBody, storeNbr, fromIso, { restartTokens: restart });
      const rep = await replayInTab(tab.id, cap.url, body, cap.reqHeaders);
      const auth = classifyAuthResponse({ status: rep.status ?? 0, contentType: rep.contentType || "", body: rep.body || "" });
      if (isAuthFailureStatus(auth)) return { ok: false, errorClass: "AUTH", error: `Power BI replay returned ${auth} — sign in to Power BI and retry.`, loginUrl: REPORT_URL };
      if (!rep.ok) return { ok: false, errorClass: "REPLAY", error: `Cash Recycler replay failed: ${rep.error || rep.status}` };
      let data;
      try { data = JSON.parse(rep.body).results[0].result.data; } catch { return { ok: false, errorClass: "PARSE", error: "Cash Recycler response was not the expected JSON" }; }
      const dec = decodeCashRecycler(data);
      rows.push(...dec.rows);
      onProgress?.({ page: page + 1, rows: rows.length });
      if (!dec.restartTokens || !dec.rows.length) break;
      restart = dec.restartTokens;
    }
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    return { ok: true, rows, storeNbr: String(storeNbr), fromIso, fetchedAt: new Date().toISOString(), dateMin: dates[0] || null, dateMax: dates.at(-1) || null, reportUrl: REPORT_URL };
  }, {
    active: false,
    // Reuse only a tab that is on THIS report. The default would take the
    // first app.powerbi.com tab (usually the long/short report), never see
    // a Cash_Recycler query there, and leave the user's tab alone but empty-handed.
    match: "https://app.powerbi.com/*",
    accept: (t) => String(t.url || "").includes(REPORT_ID),
  });
}
