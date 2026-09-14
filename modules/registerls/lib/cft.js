// modules/registerls/lib/cft.js
//
// Power BI "Cash Fund Transfers" report (reportId 22a4bd64-…): every CFT
// keyed at the store — business date, when it was actually keyed (input
// date/time), account, recipient, reason, amount. A CFT is cash taken out of
// a register (money center, service desk, garden, automotive, electronics…)
// and keyed to tell the system why. Keyed late or to the wrong business day,
// it shows up as a register shortage; the report has no register column, so
// the module can only line a CFT up by amount and date and hand the analyst
// the who/why to confirm.
//
// Capture → replay → decode, same as cash_recycler.js. The report's own
// table query is ring-buffered by content/powerbi_cft_capture.js; the
// service worker rewrites its Where (store + business date) and Window and
// replays it in the report tab. Wire shape in dev/REGISTER_LS_FINDINGS.md §5.

import { decodeDsr } from "../../digitallocks/lib/dsrDecode.js";
import { withTempTab } from "../../../shared/tabs.js";
import { classifyAuthResponse, isAuthFailureStatus } from "../../../shared/auth.js";

const CAP_KEY = "__APAISUITE_REGISTERLS_CFT_CAP";
const WINDOW_COUNT = 5000;
const MAX_PAGES = 8;

export const REPORT_ID  = "22a4bd64-8f29-4be0-bf3a-15834366dee9";
export const REPORT_URL = `https://app.powerbi.com/reportEmbed?reportId=${REPORT_ID}&autoAuth=true&ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d`;

// ── Pure: query rewrite ────────────────────────────────────────────

// Keeps the report's own "Exclude Resets" slicer condition, adds the store
// and a business-date floor, and widens the row window.
export function buildFilteredBody(capturedBody, storeNbr, fromIso, { count = WINDOW_COUNT, restartTokens = null } = {}) {
  const j = JSON.parse(capturedBody);
  const q = j.queries?.[0];
  const cmd = q?.Query?.Commands?.[0]?.SemanticQueryDataShapeCommand;
  if (!cmd) throw new Error("not a SemanticQueryDataShapeCommand body");
  const src = cmd.Query.From?.[0]?.Name || "c";
  const col = (prop) => ({ Column: { Expression: { SourceRef: { Source: src } }, Property: prop } });
  const keep = (cmd.Query.Where || []).filter((w) => JSON.stringify(w).includes('"Reset Filter"'));
  cmd.Query.Where = [
    ...keep,
    { Condition: { Comparison: { ComparisonKind: 0, Left: col("STORE"), Right: { Literal: { Value: `${String(storeNbr)}L` } } } } },
    { Condition: { Comparison: { ComparisonKind: 2, Left: col("BUSINESS_DATE"), Right: { Literal: { Value: `datetime'${fromIso}T00:00:00'` } } } } },
  ];
  cmd.Binding = cmd.Binding || {};
  cmd.Binding.DataReduction = cmd.Binding.DataReduction || { DataVolume: 3, Primary: {} };
  cmd.Binding.DataReduction.Primary = { Window: restartTokens ? { Count: count, RestartTokens: restartTokens } : { Count: count } };
  delete q.CacheKey;
  return JSON.stringify(j);
}

// ── Pure: decode ───────────────────────────────────────────────────

export function decodeCft(dataBlock) {
  const ds = dataBlock?.dsr?.DS?.[0];
  if (!ds) return { rows: [], restartTokens: null };
  const raw = decodeDsr({ descriptor: { Select: dsrColumnOrder(dataBlock) }, dsr: dataBlock.dsr });
  const rows = raw.map(normalizeRow).filter(Boolean);
  return { rows, restartTokens: ds.RT || null };
}

// The DSR lays a row out as its grouping columns (G0..Gn) followed by its
// measures (M0..Mm), while the descriptor lists them in the visual's own
// order (this table puts Sum(CFT_AMOUNT) second). decodeDsr maps values by
// descriptor position, so hand it the descriptor in DSR order.
export function dsrColumnOrder(dataBlock) {
  const sel = dataBlock?.descriptor?.Select || [];
  const schema = dataBlock?.dsr?.DS?.[0]?.PH?.[0]?.DM0?.[0]?.S;
  if (!Array.isArray(schema) || schema.length !== sel.length) return sel;
  const groups = sel.filter((c) => c.Kind !== 2), measures = sel.filter((c) => c.Kind === 2);
  let g = 0, m = 0;
  const out = schema.map((c) => (/^M/.test(c.N) ? measures[m++] : groups[g++]));
  return out.every(Boolean) ? out : sel;
}

// Column names in the descriptor are "CFT_Data.X" or "Sum(CFT_Data.X)" /
// "CountNonNull(CFT_Data.X)" depending on the visual's aggregation.
function pick(r, prop) {
  for (const k of Object.keys(r)) if (k === prop || k.endsWith(`.${prop}`) || k.endsWith(`.${prop})`)) return r[k];
  return undefined;
}
const isoDate = (ms) => (typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : (typeof ms === "string" && /^\d{4}-\d{2}-\d{2}/.test(ms) ? ms.slice(0, 10) : null));

export function normalizeRow(r) {
  const businessDate = isoDate(pick(r, "BUSINESS_DATE"));
  if (!businessDate) return null;
  const inputDate = isoDate(pick(r, "INPUT_DATE"));
  const tm = String(pick(r, "INPUT_TIME") || "");
  const inputTime = (tm.match(/T(\d{2}:\d{2}:\d{2})/) || [])[1] || (tm.match(/^\d{2}:\d{2}:\d{2}/) || [])[0] || "";
  const amount = Number(pick(r, "CFT_AMOUNT") || 0);
  return {
    store:        String(pick(r, "STORE") ?? ""),
    date:         businessDate,                 // alias for date-range helpers
    businessDate, inputDate, inputTime,
    cftId:        String(pick(r, "CFT_ID") ?? ""),
    accountNbr:   String(pick(r, "ACCOUNT_NBR") ?? ""),
    accountDesc:  String(pick(r, "ACCOUNT_DESC") ?? "").trim(),
    recipient:    String(pick(r, "RECIPIENT_NAME") ?? "").trim(),
    reason:       String(pick(r, "CFT_REASON") ?? "").trim(),
    amountCents:  Math.round(amount * 100),
    system:       /system generated/i.test(String(pick(r, "ACCOUNT_DESC") ?? "")) || /system generated/i.test(String(pick(r, "RECIPIENT_NAME") ?? "")),
    keyedLate:    !!(inputDate && businessDate && inputDate > businessDate),
  };
}

// CFTs that could touch one work item: keyed or dated within ±days of it.
export function cftFor(rows, item, { days = 10 } = {}) {
  if (!rows?.length || !item?.date) return [];
  const t0 = new Date(item.date).getTime();
  const near = (d) => d && Math.abs(new Date(d).getTime() - t0) <= days * 86_400_000;
  return rows.filter((r) => near(r.businessDate) || near(r.inputDate));
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

export async function fetchCft(storeNbr, { days = 60, onProgress } = {}) {
  const fromIso = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return withTempTab(REPORT_URL, async (tab) => {
    await waitForComplete(tab.id, 30_000);
    let cap = null;
    for (let i = 0; i < 60 && !cap; i++) { cap = await readCapture(tab.id); if (!cap) await new Promise((r) => setTimeout(r, 500)); }
    if (!cap) return { ok: false, errorClass: "NO_CAPTURE", error: "Cash Fund Transfers table query not captured — open the report once by hand so it renders, then retry.", loginUrl: REPORT_URL };
    const rows = [];
    let restart = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = buildFilteredBody(cap.reqBody, storeNbr, fromIso, { restartTokens: restart });
      const rep = await replayInTab(tab.id, cap.url, body, cap.reqHeaders);
      const auth = classifyAuthResponse({ status: rep.status ?? 0, contentType: rep.contentType || "", body: rep.body || "" });
      if (isAuthFailureStatus(auth)) return { ok: false, errorClass: "AUTH", error: `Power BI replay returned ${auth} — sign in to Power BI and retry.`, loginUrl: REPORT_URL };
      if (!rep.ok) return { ok: false, errorClass: "REPLAY", error: `Cash Fund Transfers replay failed: ${rep.error || rep.status}` };
      let data;
      try { data = JSON.parse(rep.body).results[0].result.data; } catch { return { ok: false, errorClass: "PARSE", error: "Cash Fund Transfers response was not the expected JSON" }; }
      const dec = decodeCft(data);
      rows.push(...dec.rows);
      onProgress?.({ page: page + 1, rows: rows.length });
      if (!dec.restartTokens || !dec.rows.length) break;
      restart = dec.restartTokens;
    }
    const dates = [...new Set(rows.map((r) => r.businessDate))].sort();
    return { ok: true, rows, storeNbr: String(storeNbr), fromIso, fetchedAt: new Date().toISOString(), dateMin: dates[0] || null, dateMax: dates.at(-1) || null, reportUrl: REPORT_URL };
  }, {
    active: false,
    match: "https://app.powerbi.com/*",
    accept: (t) => String(t.url || "").includes(REPORT_ID),
  });
}
