// modules/market120/service.js
//
// SW handlers for market120. Pass 2: real background-tab captures for
// Tableau + Power BI ISA reports. Parse failures store raw response
// previews under market120.debug.* so we can iterate without re-running
// the pipeline.

import * as freshness from "./lib/freshness.js";
import { fetchClearanceTableau } from "./lib/sources/clearance_tableau.js";
import { fetchIsaPowerbi }       from "./lib/sources/isa_powerbi.js";
import { fetchClearanceStoresTableau } from "./lib/sources/clearance_stores_tableau.js";
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
};

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
async function pullClearance() {
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

// ── Pull ISA (Power BI, two reports in one tab) ──────────────────────
async function pullIsa() {
  await freshness.startAttempt("isa");
  try {
    const result = await fetchIsaPowerbi();

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
      await chrome.storage.local.remove(K.isaKpis);
      await freshness.markError("isa", `${result.errorClass}: ${result.error}`);
      broadcast("source_complete", { sourceId: "isa", ok: false, error: result.error });
      return { ok: false, sourceId: "isa", errorClass: result.errorClass, error: result.error };
    }

    const payload = {
      isa_total_adjusted_dollars: result.kpis.isa_total_adjusted_dollars,
      isa_total_adjusted_qty:     result.kpis.isa_total_adjusted_qty,
      stolen_adjusted_dollars:    result.kpis.stolen_adjusted_dollars,
      capturedAt:                 result.capturedAt,
    };
    await chrome.storage.local.set({ [K.isaKpis]: payload });
    await freshness.markSuccess("isa");
    broadcast("source_complete", { sourceId: "isa", ok: true });
    return { ok: true, sourceId: "isa", kpis: payload };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("isa", err);
    broadcast("source_complete", { sourceId: "isa", ok: false, error: err });
    return { ok: false, sourceId: "isa", error: err };
  }
}

async function pullAll() {
  const [c, i, s] = await Promise.allSettled([pullClearance(), pullIsa(), pullStores()]);
  return {
    ok: true,
    clearance: c.status === "fulfilled" ? c.value : { ok: false, error: String(c.reason?.message ?? c.reason) },
    isa:       i.status === "fulfilled" ? i.value : { ok: false, error: String(i.reason?.message ?? i.reason) },
    stores:    s.status === "fulfilled" ? s.value : { ok: false, error: String(s.reason?.message ?? s.reason) },
  };
}

// ── Pull store-level Clearance/Deleted (crosstab CSV) + record WoW ────
async function pullStores() {
  await freshness.startAttempt("stores");
  try {
    const result = await fetchClearanceStoresTableau();

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

// ── Handler exports ─────────────────────────────────────────────────
export const handlers = {
  async "get_state"(_msg)      { return await getState(); },
  async "get_debug"(_msg)      { return await getDebug(); },
  async "get_wow"(_msg)        { return await getWoW(); },
  async "pull_all"(_msg)       { return await pullAll(); },
  async "pull_clearance"(_msg) { return await pullClearance(); },
  async "pull_isa"(_msg)       { return await pullIsa(); },
  async "pull_stores"(_msg)    { return await pullStores(); },
};
