// modules/market120/service.js
//
// SW handlers for market120. Pass 2: real background-tab captures for
// Tableau + Power BI ISA reports. Parse failures store raw response
// previews under market120.debug.* so we can iterate without re-running
// the pipeline.

import * as freshness from "./lib/freshness.js";
import { fetchClearanceTableau } from "./lib/sources/clearance_tableau.js";
import { fetchIsaReview, fetchIsaStoreDetail, WINDOW_PRESETS } from "./lib/sources/isa_powerbi.js";
import { fetchClearanceStoresTableau } from "./lib/sources/clearance_stores_tableau.js";
import { fetchStoreDetail } from "./lib/sources/store_detail_tableau.js";
import * as history from "./lib/history.js";
import { computeBreakdown } from "./lib/breakdown.js";

// ── Storage keys ─────────────────────────────────────────────────────
const K = {
  clearanceKpis: "market120.kpis.clearance",
  isaKpis:       "market120.kpis.isa",
  debugClearance: "market120.debug.clearance",
  debugIsa:       "market120.debug.isa",
  debugStores:   "market120.debug.stores",
  breakdown:     "market120.breakdown.stores",
  history:       "market120.history.stores",
  storeDetail:   "market120.storeDetail",
  isaReview:     "market120.isa.review",
  isaStoreDetail: "market120.isa.storeDetail",
  isaSettings:   "market120.isa.settings",
};

const STORE_DETAIL_MAX = 12;   // cached per-store item detail entries

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: "market120", type, payload }).catch(() => {});
}

async function getState() {
  const [clearance, isa, debugC, debugI] = await Promise.all([
    chrome.storage.local.get(K.clearanceKpis),
    chrome.storage.local.get(K.isaKpis),
    chrome.storage.local.get(K.debugClearance),
    chrome.storage.local.get(K.debugIsa),
  ]);
  const fresh = await freshness.readAll();
  return {
    ok: true,
    clearance: {
      kpis:      clearance[K.clearanceKpis] || null,
      freshness: fresh.clearance,
      debug:     debugC[K.debugClearance] || null,
    },
    isa: {
      kpis:      isa[K.isaKpis] || null,
      freshness: fresh.isa,
      debug:     debugI[K.debugIsa] || null,
    },
  };
}

// ── Pull Clearance (Tableau) ─────────────────────────────────────────
// The KPI cards on ClearanceDeleted are server-rendered PNG tiles, so the
// VizQL scrape (fetchClearanceTableau) can never read them. The tiles are
// fed from the CD Store crosstab instead: Market 120 = sum of its stores.
async function pullClearance() {
  await freshness.startAttempt("clearance");
  // Drop the previous attempt's error so a stale NOT_PARSEABLE panel doesn't
  // sit on screen while this pull runs.
  await chrome.storage.local.remove(K.debugClearance);
  const res = await pullStores();
  if (!res.ok) {
    await chrome.storage.local.set({
      [K.debugClearance]: { ok: false, errorClass: res.errorClass || null, error: res.error || null, capturedAt: new Date().toISOString() },
    });
    await chrome.storage.local.remove(K.clearanceKpis);
    await freshness.markError("clearance", `${res.errorClass || "ERROR"}: ${res.error}`);
    return { ok: false, sourceId: "clearance", errorClass: res.errorClass, error: res.error };
  }
  return { ok: true, sourceId: "clearance", storeCount: res.storeCount };
}

async function writeClearanceKpis(breakdown, capturedAt) {
  const m = breakdown?.market120;
  if (!m) return;
  // Deleted-on-Clearance $ isn't in the store crosstab; leave the key out so
  // the tile shows "—" without flagging a partial capture.
  await chrome.storage.local.set({
    [K.clearanceKpis]:  { clearance_dollars: m.clrDol, deleted_dollars: m.delDol, capturedAt },
    [K.debugClearance]: { ok: true, errorClass: null, error: null, capturedAt },
  });
  await freshness.markSuccess("clearance");
  broadcast("source_complete", { sourceId: "clearance", ok: true });
}

// Legacy VizQL KPI-tile scrape — kept for reference, not wired to any handler.
async function pullClearanceKpiTiles() {
  await freshness.startAttempt("clearance");
  try {
    const result = await fetchClearanceTableau();

    // Always persist the debug envelope so we can inspect the last attempt
    // regardless of success. Bounded size — the source functions already
    // truncate respBodyPreview to 4 KB.
    await chrome.storage.local.set({
      [K.debugClearance]: {
        ok:         result.ok,
        errorClass: result.errorClass || null,
        error:      result.error || null,
        debug:      result.debug || null,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      // A failed capture must not leave a prior (possibly poisoned) KPI
      // payload on screen showing stale numbers as if fresh. Clear it so the
      // UI falls back to the unknown marker plus the error freshness state.
      await chrome.storage.local.remove(K.clearanceKpis);
      // NOT_PARSEABLE is a KNOWN limitation (PNG-tile workbook), not a real
      // error — surface it as a neutral "unavailable" badge, not a red
      // "error — see console" pointing at an empty console.
      if (result.errorClass === "NOT_PARSEABLE") {
        await freshness.markUnavailable("clearance", result.error);
      } else {
        await freshness.markError("clearance", `${result.errorClass}: ${result.error}`);
      }
      broadcast("source_complete", { sourceId: "clearance", ok: false, error: result.error });
      return { ok: false, sourceId: "clearance", errorClass: result.errorClass, error: result.error };
    }

    const payload = {
      clearance_dollars:            result.kpis.clearance_dollars,
      deleted_dollars:              result.kpis.deleted_dollars,
      deleted_on_clearance_dollars: result.kpis.deleted_on_clearance_dollars,
      capturedAt:                   result.capturedAt,
    };
    await chrome.storage.local.set({ [K.clearanceKpis]: payload });
    await freshness.markSuccess("clearance");
    broadcast("source_complete", { sourceId: "clearance", ok: true });
    return { ok: true, sourceId: "clearance", kpis: payload };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("clearance", err);
    broadcast("source_complete", { sourceId: "clearance", ok: false, error: err });
    return { ok: false, sourceId: "clearance", error: err };
  }
}

// ── Pull ISA (Power BI, built Market 120 queries) ────────────────────
// See lib/sources/isa_powerbi.js for why the old card capture was replaced:
// the reports' saved slicers made those cards store 1458 / Market 29.
async function readIsaDays() {
  const got = await chrome.storage.local.get(K.isaSettings);
  const d = Number(got[K.isaSettings]?.days);
  return WINDOW_PRESETS.includes(d) ? d : 14;
}

async function pullIsa(msg = {}) {
  await freshness.startAttempt("isa");
  try {
    const requested = Number(msg?.days);
    const days = WINDOW_PRESETS.includes(requested) ? requested : await readIsaDays();
    const result = await fetchIsaReview({ days });

    await chrome.storage.local.set({
      [K.debugIsa]: {
        ok:         result.ok,
        errorClass: result.errorClass || null,
        error:      result.error || null,
        subErrors:  result.subErrors || null,
        debug:      result.debug || null,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      // KPI tiles go blank rather than show a stale (possibly old-scope)
      // number. The last review stays: it is labelled with its own window.
      await chrome.storage.local.remove(K.isaKpis);
      await freshness.markError("isa", `${result.errorClass}: ${result.error}`);
      broadcast("source_complete", { sourceId: "isa", ok: false, error: result.error });
      return { ok: false, sourceId: "isa", errorClass: result.errorClass, error: result.error };
    }

    const review = result.review;
    const payload = {
      ...result.kpis,
      scope: { market: review.market, window: review.window, dataThrough: review.dataThrough, fyFrom: review.fyFrom },
      capturedAt: result.capturedAt,
    };
    const prev = (await chrome.storage.local.get(K.isaReview))[K.isaReview];
    const sameWindow = prev?.window?.from === review.window.from && prev?.window?.to === review.window.to;
    await chrome.storage.local.set({
      [K.isaKpis]: payload,
      [K.isaReview]: { ...review, capturedAt: result.capturedAt },
      [K.isaSettings]: { days },
      ...(sameWindow ? {} : { [K.isaStoreDetail]: {} }),
    });
    await freshness.markSuccess("isa");
    broadcast("source_complete", { sourceId: "isa", ok: true });
    return { ok: true, sourceId: "isa", kpis: payload, window: review.window };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("isa", err);
    broadcast("source_complete", { sourceId: "isa", ok: false, error: err });
    return { ok: false, sourceId: "isa", error: err };
  }
}

async function getIsaReview() {
  const got = await chrome.storage.local.get(K.isaReview);
  return {
    ok: true,
    review: got[K.isaReview] || null,
    settings: { days: await readIsaDays() },
    presets: WINDOW_PRESETS,
    freshness: await freshness.read("isa"),
  };
}

const ISA_STORE_DETAIL_MAX = 12;

// Item lines for one store: cached per review window; Power BI only when
// missing or on refresh.
async function getIsaStoreDetail(msg) {
  const store = String(msg?.store ?? "").trim();
  if (!store) return { ok: false, error: "store is required" };
  const got = await chrome.storage.local.get([K.isaReview, K.isaStoreDetail]);
  const review = got[K.isaReview];
  if (!review) return { ok: true, store, detail: null, detailError: "Load the ISA review first (Refresh)." };

  let detail = (got[K.isaStoreDetail] || {})[store] || null;
  if (detail && (detail.window?.from !== review.window.from || detail.window?.to !== review.window.to)) detail = null;
  let detailError = null;

  if (msg.refresh || !detail) {
    const r = await fetchIsaStoreDetail(store, { window: review.window, fyFrom: review.fyFrom });
    if (r.ok) {
      detail = r.detail;
      const cache = (await chrome.storage.local.get(K.isaStoreDetail))[K.isaStoreDetail] || {};
      cache[store] = detail;
      const keep = Object.values(cache)
        .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
        .slice(0, ISA_STORE_DETAIL_MAX);
      await chrome.storage.local.set({ [K.isaStoreDetail]: Object.fromEntries(keep.map((d) => [d.store, d])) });
    } else {
      detailError = `${r.errorClass}: ${r.error}`;
    }
  }
  return { ok: true, store, detail, detailError };
}

async function pullAll() {
  // pullClearance runs the store crosstab pull itself; running pullStores
  // alongside it would race two exports on the same Tableau tab.
  const [c, i] = await Promise.allSettled([pullClearance(), pullIsa()]);
  const clearance = c.status === "fulfilled" ? c.value : { ok: false, error: String(c.reason?.message ?? c.reason) };
  return {
    ok: true,
    clearance,
    isa:    i.status === "fulfilled" ? i.value : { ok: false, error: String(i.reason?.message ?? i.reason) },
    stores: clearance,
  };
}

// ── Pull store-level Clearance/Deleted (crosstab CSV) + record WoW ────
async function pullStores() {
  await freshness.startAttempt("stores");
  try {
    // Hard cap so the Refresh spinner always stops, whatever Tableau does.
    const PULL_CAP_MS = 4 * 60_000;
    let capTimer;
    const result = await Promise.race([
      fetchClearanceStoresTableau(),
      new Promise((res) => { capTimer = setTimeout(() => res({ ok: false, errorClass: "TIMEOUT", error: `Store capture did not finish within ${PULL_CAP_MS / 1000}s. Check the Tableau tab for an SSO prompt, then Refresh again.` }), PULL_CAP_MS); }),
    ]).finally(() => clearTimeout(capTimer));

    await chrome.storage.local.set({
      [K.debugStores]: {
        ok:         result.ok,
        errorClass: result.errorClass || null,
        error:      result.error || null,
        debug:      result.debug || null,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      await freshness.markError("stores", `${result.errorClass}: ${result.error}`);
      broadcast("source_complete", { sourceId: "stores", ok: false, error: result.error });
      return { ok: false, sourceId: "stores", errorClass: result.errorClass, error: result.error };
    }

    // Record this week's snapshot (idempotent within the ISO week).
    const rec = await history.recordSnapshot(result.rows);

    // Compute + persist the full market breakdown (KPIs, national context,
    // clearance/deleted split, top stores, insights) so the UI can render the
    // report-style page without recomputing on every paint.
    const breakdown = computeBreakdown(result.rows, result.national, { market: "120", topN: 10 });
    await chrome.storage.local.set({
      [K.breakdown]: { ...breakdown, capturedAt: result.capturedAt },
    });
    await writeClearanceKpis(breakdown, result.capturedAt);

    await freshness.markSuccess("stores");
    broadcast("source_complete", { sourceId: "stores", ok: true });
    return { ok: true, sourceId: "stores", weekKey: rec.weekKey, storeCount: rec.storeCount };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("stores", err);
    broadcast("source_complete", { sourceId: "stores", ok: false, error: err });
    return { ok: false, sourceId: "stores", error: err };
  }
}

async function getWoW() {
  const wow = await history.computeWoW();
  const fresh = await freshness.read("stores");
  const got = await chrome.storage.local.get(K.breakdown);
  return { ok: true, wow, breakdown: got[K.breakdown] || null, freshness: fresh };
}

// Handy for troubleshooting — read raw debug envelopes without going through
// the full pull. Returns the last known capture state per source.
async function getDebug() {
  const [debugC, debugI] = await Promise.all([
    chrome.storage.local.get(K.debugClearance),
    chrome.storage.local.get(K.debugIsa),
  ]);
  return {
    ok: true,
    clearance: debugC[K.debugClearance] || null,
    isa:       debugI[K.debugIsa] || null,
  };
}

// ── Store drill-down ────────────────────────────────────────────────
// Totals/rank/history come from storage (instant). Item detail is read from
// Tableau only when msg.fetch and nothing is cached, or on msg.refresh.
async function getStoreDetail(msg) {
  const store = String(msg?.store ?? "").trim();
  if (!store) return { ok: false, error: "store is required" };

  const got = await chrome.storage.local.get([K.breakdown, K.history, K.storeDetail]);
  const bd = got[K.breakdown] || null;
  const all = bd?.stores || bd?.topStores || [];
  const row = all.find((s) => String(s.store) === store) || null;
  const m = bd?.market120;
  const ranked = [...all].sort((a, b) => b.dollars - a.dollars);
  const context = m && row
    ? {
        rank: ranked.findIndex((s) => String(s.store) === store) + 1,
        storeCount: m.storeCount,
        shareOfMarket: m.dollars ? (row.dollars / m.dollars) * 100 : 0,
        marketAvg: m.storeCount ? m.dollars / m.storeCount : null,
      }
    : null;

  const weeks = got[K.history]?.weeks || {};
  const history = Object.keys(weeks).sort()
    .filter((w) => weeks[w].stores?.[store])
    .map((w) => ({ week: w, ...weeks[w].stores[store] }));

  let detail = (got[K.storeDetail] || {})[store] || null;
  let detailError = null;
  if (msg.refresh || (msg.fetch && !detail)) {
    const r = await fetchStoreDetail(store);
    if (r.ok) {
      detail = r.detail;
      // Re-read before writing: another store's fetch may have landed meanwhile.
      const cache = (await chrome.storage.local.get(K.storeDetail))[K.storeDetail] || {};
      cache[store] = detail;
      const keep = Object.values(cache)
        .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
        .slice(0, STORE_DETAIL_MAX);
      await chrome.storage.local.set({ [K.storeDetail]: Object.fromEntries(keep.map((d) => [d.store, d])) });
    } else {
      detailError = `${r.errorClass}: ${r.error}`;
    }
  }

  return { ok: true, store, row, context, history, detail, detailError };
}

// ── Handler exports ─────────────────────────────────────────────────
export const handlers = {
  async "get_state"(_msg)      { return await getState(); },
  async "get_debug"(_msg)      { return await getDebug(); },
  async "get_wow"(_msg)        { return await getWoW(); },
  async "pull_all"(_msg)       { return await pullAll(); },
  async "pull_clearance"(_msg) { return await pullClearance(); },
  async "pull_isa"(msg)        { return await pullIsa(msg); },
  async "get_isa_review"(_msg) { return await getIsaReview(); },
  async "get_isa_store_detail"(msg) { return await getIsaStoreDetail(msg); },
  async "pull_stores"(_msg)    { return await pullStores(); },
  async "get_store_detail"(msg) { return await getStoreDetail(msg); },
};
