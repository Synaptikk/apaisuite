// modules/registerls/lib/open_drawer.js
//
// APPRISS Explorer "Open Drawer" — the supporting search WorkView links from
// every long/short item: every transaction that opened the drawer on one
// register on one trading day, with APPRISS's own transaction id. That id is
// what the CCTV viewer and the receipt viewer key on, so this is how a
// journal transaction (TR#) becomes a "watch the video" link.
//
//   viewer URLs (same as aurorbuddy/lib/appriss.js):
//     video/react#/cameras?transactionId=<id>
//     platform/viewer?hidechrome=true#/store/ardm/event/<id>
//
// Wire shape in dev/REGISTER_LS_FINDINGS.md §1 (probed 2026-09-14).

import { postJson } from "../../aurorbuddy/lib/appriss_http.js";
import { APPRISS_BASE, APPRISS_HOME } from "../../../shared/appriss.js";

export const SEARCH_PATH = "/public/work items/supporting searches/open drawer.search";
export const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export const cctvUrl    = (tid) => `${APPRISS_BASE}/video/react#/cameras?transactionId=${tid}`;
export const receiptUrl = (tid) => `${APPRISS_BASE}/platform/viewer?hidechrome=true#/store/ardm/event/${tid}`;
export const viewerUrl  = (tid) => `${APPRISS_BASE}/platform/viewer#/store/ardm/search/${tid}`;

// "2026-08-27" → "8/27/2026 12:00:00 AM" (the search's tradingday parameter).
export function tradingDay(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return `${m}/${d}/${y} 12:00:00 AM`;
}

export const EXPLORER_URL = (storeNbr, registerNbr, dateIso) =>
  `${APPRISS_BASE}/platform/explorer#/results?searchPath=${encodeURIComponent(SEARCH_PATH)}` +
  `&storeno=${storeNbr}&posno=${registerNbr}&tradingday=${encodeURIComponent(tradingDay(dateIso))}`;

export function buildOpenDrawerBody(storeNbr, registerNbr, dateIso, { startIndex = 0, pageSize = PAGE_SIZE } = {}) {
  return {
    searchVirtualFilePath: SEARCH_PATH,
    builderVirtualFilePath: "",
    presentationType: "grid",
    startIndex, sortColumn: "", pageSize, sortOrder: "none",
    disableDrill: false, filter: "", forceRun: false, showFullLoader: false,
    conditionsToSkip: [],
    preventRunningWhenNonRequiredParameterisedConditionsHaveMissingValues: true,
    parameters: {
      searchPath: SEARCH_PATH,
      storeno: String(storeNbr),
      posno: String(registerNbr),
      tradingday: tradingDay(dateIso),
    },
    rowData: {}, canOfferRerun: true,
  };
}

const cell = (row, k) => { const v = row?.[k]; return v && typeof v === "object" ? (v.cellValue ?? "") : (v ?? ""); };
const money = (v) => { const n = Number(String(v).replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const stripZeros = (v) => String(v ?? "").replace(/^0+(?=\d)/, "");

// One search page → normalized rows. Accepts the envelope or its `data`.
export function decodeOpenDrawer(payload) {
  const d = payload?.data?.rows ? payload.data : payload;
  const rows = (d?.rows || []).map((r) => {
    const tid = String(cell(r, "transactionid") || "").trim();
    const dt = String(cell(r, "endtransdatetime") || "");
    const [date, time] = dt.split(" ");
    const t = (time || "").slice(0, 8);
    return {
      store:         String(cell(r, "storeno")),
      register:      String(cell(r, "posno")),
      cashier:       stripZeros(cell(r, "storecashierno")),
      transNum:      stripZeros(cell(r, "ticketno")),
      amountCents:   money(cell(r, "ticketamount")),
      cashTendCents: money(cell(r, "tendercashamount")),
      changeCents:   money(cell(r, "tenderchangeamount")),
      cashBackCents: money(cell(r, "tendercashbackamount")),
      date: date || null, time: t || null,
      timeInt: /^\d{2}:\d{2}:\d{2}$/.test(t) ? Number(t.replace(/:/g, "")) : null,
      transactionId: tid || null,
      cctvUrl: tid ? cctvUrl(tid) : null,
      receiptUrl: tid ? receiptUrl(tid) : null,
      viewerUrl: tid ? viewerUrl(tid) : null,
    };
  });
  return { rows, totalRows: Number(d?.totalRows ?? rows.length), lastRowIndex: Number(d?.lastRowIndex ?? rows.length - 1) };
}

// Attach { transactionId, cctvUrl, receiptUrl } to journal-derived objects
// that carry a transNum (cash matches, investigation candidates, red flags).
// Falls back to the closest end time within 90 s when TR# is missing.
export function linkVideo(list, drawerRows) {
  if (!Array.isArray(list) || !drawerRows?.length) return list || [];
  const byTr = new Map();
  for (const r of drawerRows) if (r.transNum) byTr.set(String(r.transNum), r);
  const secs = (t) => { const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    let r = x.transNum != null ? byTr.get(stripZeros(x.transNum)) : null;
    if (!r && x.time) {
      const s = secs(x.time);
      if (s != null) r = drawerRows.filter((d) => secs(d.time) != null && Math.abs(secs(d.time) - s) <= 90).sort((a, b) => Math.abs(secs(a.time) - s) - Math.abs(secs(b.time) - s))[0] || null;
    }
    if (r?.transactionId) x.video = { transactionId: r.transactionId, cctvUrl: r.cctvUrl, receiptUrl: r.receiptUrl, viewerUrl: r.viewerUrl, byTime: !byTr.has(stripZeros(x.transNum ?? "")) };
  }
  return list;
}

// Service-worker side: every page of the search for one register-day.
export async function fetchOpenDrawer(storeNbr, registerNbr, dateIso, { signal } = {}) {
  const rows = [];
  let startIndex = 0, totalRows = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await postJson(buildOpenDrawerBody(storeNbr, registerNbr, dateIso, { startIndex }), { label: `open-drawer ${storeNbr}/${registerNbr} ${dateIso}`, signal });
    if (!data) {
      if (rows.length) break;
      return { ok: false, errorClass: "AUTH_OR_HTTP", error: "Open Drawer search failed — APPRISS session expired or the search errored. Sign in to Secure and retry.", loginUrl: APPRISS_HOME };
    }
    const page1 = decodeOpenDrawer(data);
    rows.push(...page1.rows);
    totalRows = page1.totalRows;
    if (!page1.rows.length || rows.length >= totalRows) break;
    startIndex = page1.lastRowIndex + 1;
  }
  return { ok: true, rows, totalRows: totalRows ?? rows.length, fetchedAt: new Date().toISOString(), explorerUrl: EXPLORER_URL(storeNbr, registerNbr, dateIso) };
}
