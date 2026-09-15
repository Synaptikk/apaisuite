// modules/market120/lib/sources/isa_powerbi.js
//
// Market 120 ISA review from Power BI, read with queries we BUILD
// (shared/pbi_query.js) rather than values scraped from whatever the report
// rendered.
//
// Why the rewrite (measured live 2026-09-15): both reports persist the
// analyst's slicers, and the old capture read the cards those slicers
// produced.
//   - ISA Detail was saved on Market 120 + Store 1458 + reason ISA, so
//     "Total Adjusted $" was store 1458's figure, not the market's.
//   - Backroom Adjustments was saved on Market 29 + Stolen, so the page's
//     "Stolen Adj $ $46,758" was Market 29's. Market 120 FY-to-date is
//     -$400,300 (reconciled two ways: store×type and the item grid).
//
// What we read now, all filtered to Market 120 by us:
//   ISA Detail (entity ISA)            daily trend over a lookback, then a
//                                      store × reason × dept × category rollup
//                                      and store × reason × source for the
//                                      review window; per-store item lines on
//                                      demand (the whole market's item grid
//                                      exceeds Power BI's 30,000-row cap).
//   Backroom Adjustments (BR Adjustments)  store × adjustment type for the
//                                      fiscal year and for the window; Stolen
//                                      item lines per store on demand.
//
// Transport (QES url, MWCToken, modelId) comes from the market120 Power BI
// capture ring in a background tab WE open — never the user's own Power BI
// tab — and is cached per report in chrome.storage.session (memory only).
// The two reports use different semantic models, so each has its own.

import {
  AGG, MAX_WINDOW, aggregate, buildQuery, column, decodeRows, measure,
  pickTransport, readResult, whereDateRange, whereIn,
} from "../../../../shared/pbi_query.js";
import {
  aggregateStolenItems, aggregateStoreItems, buildReview, fiscalYearStart,
  latestDataDate, windowFromMaxDate, ymd,
} from "../isa_review.js";
import { execScript, waitForTabLoad } from "./clearance_stores_tableau.js";

const APP_ID = "a185f4ed-8506-49a6-b135-743608a56ae6";
const CTID   = "3cbcc3d3-094d-4006-9849-0d11d61f484d";
const ISA_DETAIL_URL   = `https://app.powerbi.com/groups/me/apps/${APP_ID}/reports/b4835e03-3718-4b95-919f-8934bc83542c/ReportSection86afef1c8628ab2fa9d0?ctid=${CTID}&experience=power-bi`;
const BACKROOM_ADJ_URL = `https://app.powerbi.com/groups/me/apps/${APP_ID}/reports/c929bfda-c409-49f5-b2cb-732370411af3/ReportSection?ctid=${CTID}&experience=power-bi`;

const MARKET = "120";
const REPORTS = {
  isa: { entity: "ISA",            url: ISA_DETAIL_URL,   from: [{ Name: "i", Entity: "ISA" }, { Name: "a", Entity: "Alignment" }] },
  br:  { entity: "BR Adjustments", url: BACKROOM_ADJ_URL, from: [{ Name: "b", Entity: "BR Adjustments" }, { Name: "a", Entity: "Alignment" }] },
};

export const WINDOW_PRESETS = [7, 14, 28];

const DAY = 86_400_000;
const LOOKBACK_DAYS        = 42;          // daily trend; also finds the data-through date
const TRANSPORT_KEY        = "market120.pbiTransport";
const TRANSPORT_MAX_AGE_MS = 45 * 60_000; // MWCToken observed to live ~82 min
const TRANSPORT_WAIT_MS    = 60_000;
const LOAD_TIMEOUT_MS      = 30_000;
const QUERY_TIMEOUT_MS     = 60_000;

const m120 = () => whereIn(column("a", "Market"), [MARKET]);
const cents = (v) => Math.round(v * 100) / 100;

/**
 * Market-level review for a `days` window ending on the latest date with data.
 * @returns {Promise<{ok, kpis?, review?, capturedAt?, subErrors?, debug?, errorClass?, error?}>}
 */
export async function fetchIsaReview({ days = 14 } = {}) {
  if (!WINDOW_PRESETS.includes(days)) days = 14;
  const started = Date.now();
  const debug = { queries: {} };

  const lookFrom = ymd(Date.now() - LOOKBACK_DAYS * DAY);
  const trend = await runQuery("isa", {
    select: [
      ["Store", column("a", "Store")], ["Reason", column("i", "Adj Reason")],
      ["Date", column("i", "Adj Date")], ["Dollars", measure("i", "Adj $")],
    ],
    where: [m120(), whereDateRange(column("i", "Adj Date"), lookFrom, ymd(Date.now() + DAY))],
  }, debug, "trend");
  if (!trend.ok) return trend;

  const maxMs = latestDataDate(trend.rows);
  if (maxMs == null) {
    return { ok: false, errorClass: "NO_DATA", error: `No Market ${MARKET} ISA adjustments since ${lookFrom}.`, debug };
  }
  const window = windowFromMaxDate(maxMs, days);
  const fyFrom = fiscalYearStart(maxMs);
  const inWindow = [m120(), whereDateRange(column("i", "Adj Date"), window.from, window.to)];

  const rollup = await runQuery("isa", {
    select: [
      ["Store", column("a", "Store")], ["Reason", column("i", "Adj Reason")],
      ["Dept", column("i", "Dept")], ["Cat", column("i", "Cat Desc")],
      ["Dollars", measure("i", "Adj $")], ["Qty", aggregate("i", "Adj Qty", AGG.SUM)],
      ["Lines", aggregate("i", "Adj Qty", AGG.COUNT_NON_NULL)],
    ],
    where: inWindow,
  }, debug, "rollup");
  if (!rollup.ok) return rollup;

  const sources = await runQuery("isa", {
    select: [
      ["Store", column("a", "Store")], ["Reason", column("i", "Adj Reason")],
      ["Source", column("i", "User ID")], ["Dollars", measure("i", "Adj $")],
    ],
    where: inWindow,
  }, debug, "sources");
  if (!sources.ok) return sources;

  // Backroom Adjustments is secondary: a failure there must not sink the ISA review.
  const subErrors = {};
  const brSelect = [
    ["Store", column("a", "Store")], ["Type", column("b", "Adjustment Type")],
    ["Dollars", aggregate("b", "Total Adj $", AGG.SUM)], ["Qty", aggregate("b", "Qty", AGG.SUM)],
  ];
  const brFy = await runQuery("br", { select: brSelect, where: [m120(), whereDateRange(column("b", "Date"), fyFrom)] }, debug, "brFy");
  let brWindow = null;
  if (brFy.ok) {
    brWindow = await runQuery("br", { select: brSelect, where: [m120(), whereDateRange(column("b", "Date"), window.from, window.to)] }, debug, "brWindow");
    if (!brWindow.ok) subErrors.backroom_window = `${brWindow.errorClass}: ${brWindow.error}`;
  } else {
    subErrors.backroom = `${brFy.errorClass}: ${brFy.error}`;
  }

  const review = buildReview({
    window, dataThrough: ymd(maxMs), fyFrom,
    trend: trend.rows, rollup: rollup.rows, sources: sources.rows,
    brFy: brFy.ok ? brFy.rows : null,
    brWindow: brWindow?.ok ? brWindow.rows : null,
  });

  let dollars = 0, qty = 0;
  for (const [, , d, q] of review.byStoreReason) { dollars += d; qty += q; }
  const stolen = review.br.fy ? review.br.fy.filter((x) => x[1] === "Stolen").reduce((a, x) => a + x[2], 0) : null;

  debug.ms = Date.now() - started;
  debug.window = window;
  debug.dataThrough = review.dataThrough;
  return {
    ok: true,
    kpis: {
      isa_total_adjusted_dollars: cents(dollars),
      isa_total_adjusted_qty:     qty,
      stolen_adjusted_dollars:    stolen == null ? null : cents(stolen),
    },
    review,
    capturedAt: new Date().toISOString(),
    subErrors: Object.keys(subErrors).length ? subErrors : null,
    debug,
  };
}

/**
 * One store's ISA item lines for the review window plus its Stolen lines for
 * the fiscal year.
 */
export async function fetchIsaStoreDetail(store, { window, fyFrom }) {
  const s = String(store ?? "").trim();
  if (!/^\d+$/.test(s)) return { ok: false, errorClass: "INPUT", error: `Bad store number: ${store}` };
  if (!window?.from || !window?.to || !fyFrom) {
    return { ok: false, errorClass: "INPUT", error: "Review window missing — refresh ISA first." };
  }
  const debug = { queries: {} };

  const items = await runQuery("isa", {
    // Sum the numbers rather than grouping on them: grouping on raw Qty/$
    // merged identical lines (store 1458: -$147,300.95 vs -$147,341.57).
    select: [
      ["Date", column("i", "Adj Date")], ["Reason", column("i", "Adj Reason")],
      ["Source", column("i", "User ID")], ["Rule", column("i", "rule_id")],
      ["Dept", column("i", "Dept")], ["Cat", column("i", "Cat Desc")],
      ["Item", column("i", "Item Nbr")], ["UPC", column("i", "UPC")], ["Desc", column("i", "Item Desc")],
      ["ItemRetail", column("i", "Item $")],
      ["Qty", aggregate("i", "Adj Qty", AGG.SUM)], ["Dollars", aggregate("i", "Adj $.", AGG.SUM)],
      ["Lines", aggregate("i", "Adj Qty", AGG.COUNT_NON_NULL)],
    ],
    where: [m120(), whereIn(column("a", "Store"), [s]), whereDateRange(column("i", "Adj Date"), window.from, window.to)],
  }, debug, "items");
  if (!items.ok) return items;

  const br = await runQuery("br", {
    select: [
      ["Date", column("b", "Date")], ["Dept", column("b", "Dept")], ["Category", column("b", "Category")],
      ["Item", column("b", "Item Nbr")], ["UPC", column("b", "UPC")], ["Desc", column("b", "Item Desc")],
      ["User", column("b", "UserID")],
      ["Qty", aggregate("b", "Qty", AGG.SUM)], ["Dollars", aggregate("b", "Total Adj $", AGG.SUM)],
    ],
    where: [
      m120(), whereIn(column("a", "Store"), [s]),
      whereIn(column("b", "Adjustment Type"), ["Stolen"]),
      whereDateRange(column("b", "Date"), fyFrom),
    ],
  }, debug, "stolen");

  return {
    ok: true,
    detail: {
      store: s, window, fyFrom,
      capturedAt: new Date().toISOString(),
      items: aggregateStoreItems(items.rows),
      stolen: br.ok ? aggregateStolenItems(br.rows) : null,
      stolenError: br.ok ? null : `${br.errorClass}: ${br.error}`,
    },
    debug,
  };
}

// ── Query execution ─────────────────────────────────────────────────
async function runQuery(reportKey, { select, where }, debug, label) {
  const report = REPORTS[reportKey];
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getTransport(reportKey, { fresh: attempt > 0 });
    if (!t.ok) return t;
    const body = buildQuery({ modelId: t.transport.modelId, from: report.from, select, where });
    const started = Date.now();
    const res = await postQuery(t.transport, body);
    // An expired token: capture a fresh one and try once more.
    if (res.auth && attempt === 0) { await dropTransport(reportKey); continue; }
    if (debug) {
      debug.queries[label] = { ok: res.ok, rows: res.rows?.length ?? 0, complete: res.complete ?? null, ms: Date.now() - started, error: res.error || null };
    }
    if (!res.ok) return res;
    if (!res.complete) {
      return {
        ok: false, errorClass: "TRUNCATED",
        error: `Power BI query "${label}" hit the ${MAX_WINDOW.toLocaleString("en-US")}-row limit; refusing a partial result.`,
      };
    }
    return res;
  }
  return { ok: false, errorClass: "AUTH", error: "Power BI rejected the session token twice. Open Power BI once to sign in, then Refresh." };
}

async function postQuery(transport, body) {
  let resp;
  try {
    resp = await fetch(transport.url, {
      method: "POST",
      headers: {
        "Authorization": transport.auth,
        "Content-Type": "application/json;charset=UTF-8",
        "X-PowerBI-HostEnv": "Power BI Web App",
        "Accept": "application/json, text/plain, */*",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, errorClass: "NETWORK", error: `Power BI query failed: ${e?.message ?? e}` };
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403 || /^\s*</.test(text)) {
    return { ok: false, auth: true, errorClass: "AUTH", error: `Power BI returned HTTP ${resp.status} (session token expired?).` };
  }
  if (!resp.ok) return { ok: false, errorClass: "HTTP", error: `Power BI HTTP ${resp.status}: ${text.slice(0, 200)}` };
  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, errorClass: "PARSE", error: "Power BI response was not JSON." }; }
  const { complete, error, warnings } = readResult(json);
  if (error) return { ok: false, errorClass: "QUERY", error: `Power BI rejected the query: ${error}` };
  for (const w of warnings) console.warn(`[market120] Power BI warning ${w?.Code}: ${w?.Message}`);
  return { ok: true, rows: decodeRows(json), complete };
}

// ── Transport ───────────────────────────────────────────────────────
async function getTransport(reportKey, { fresh = false } = {}) {
  if (!fresh) {
    const cached = await readCachedTransport(reportKey);
    if (cached) return { ok: true, transport: cached };
  }
  const report = REPORTS[reportKey];
  const captured = await captureTransport(report);
  if (!captured) {
    return {
      ok: false, errorClass: "NO_CAPTURE",
      error: `Power BI did not issue a "${report.entity}" query within ${TRANSPORT_WAIT_MS / 1000}s. ` +
             "Open the report in Power BI once to sign in, then Refresh.",
    };
  }
  await writeCachedTransport(reportKey, captured);
  return { ok: true, transport: captured };
}

async function readCachedTransport(key) {
  try {
    const t = (await chrome.storage.session.get(TRANSPORT_KEY))[TRANSPORT_KEY]?.[key];
    if (t?.auth && Date.now() - (t.cachedAt || 0) < TRANSPORT_MAX_AGE_MS) return t;
  } catch {}
  return null;
}

async function writeCachedTransport(key, transport) {
  try {
    const all = (await chrome.storage.session.get(TRANSPORT_KEY))[TRANSPORT_KEY] || {};
    all[key] = { ...transport, cachedAt: Date.now() };
    await chrome.storage.session.set({ [TRANSPORT_KEY]: all });
  } catch {}
}

async function dropTransport(key) {
  try {
    const all = (await chrome.storage.session.get(TRANSPORT_KEY))[TRANSPORT_KEY] || {};
    delete all[key];
    await chrome.storage.session.set({ [TRANSPORT_KEY]: all });
  } catch {}
}

// Open the report in our own background tab, wait for its first query against
// the report's entity, take url + token + modelId, close the tab.
async function captureTransport(report) {
  const tab = await chrome.tabs.create({ url: report.url, active: false }).catch(() => null);
  if (!tab) return null;
  try {
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
    const deadline = Date.now() + TRANSPORT_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const results = await execScript({
          target: { tabId: tab.id, allFrames: true },
          world:  "MAIN",
          args:   [report.entity],
          // Hand back descriptors only — never the (large) response bodies.
          func:   (entity) => {
            const cap = window.__APAISUITE_MARKET120_POWERBI_CAP;
            if (!cap) return null;
            const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const needle = new RegExp(`"Entity":\\s*"${escaped}"`);
            return cap.all()
              .filter((e) => e.url && e.reqBody && needle.test(e.reqBody) &&
                (e.reqHeaders?.Authorization || e.reqHeaders?.authorization))
              .slice(-3)
              .map((e) => ({
                url: e.url,
                auth: e.reqHeaders.Authorization || e.reqHeaders.authorization,
                body: e.reqBody,
                capturedAt: e.capturedAt,
              }));
          },
        }, 15_000);
        const entries = (results || []).flatMap((r) => (Array.isArray(r?.result) ? r.result : []));
        const transport = pickTransport(entries, { entity: report.entity });
        if (transport) return transport;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}
