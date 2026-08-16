// modules/vizpick/service.js
//
// SW handlers for vizpick. Background-tab capture of the VizPick Tableau
// workbook's "Download Summary by Store" crosstab. Parse failures store the
// raw ring-buffer summary under vizpick.debug.stores so capture issues can
// be diagnosed without re-running the whole pipeline.

import * as freshness from "./lib/freshness.js";
import { fetchVizpickStoresTableau } from "./lib/sources/vizpick_stores_tableau.js";

// ── Storage keys ─────────────────────────────────────────────────────
const K = {
  rows:       "vizpick.rows",
  grandTotal: "vizpick.grandTotal",
  debug:      "vizpick.debug.stores",
};

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: "vizpick", type, payload }).catch(() => {});
}

async function getState() {
  const [got, fresh] = await Promise.all([
    chrome.storage.local.get([K.rows, K.grandTotal, K.debug]),
    freshness.read("stores"),
  ]);
  return {
    ok:         true,
    rows:       got[K.rows] || [],
    grandTotal: got[K.grandTotal] || null,
    freshness:  fresh,
    debug:      got[K.debug] || null,
  };
}

async function pullStores() {
  await freshness.startAttempt("stores");
  try {
    const result = await fetchVizpickStoresTableau();

    // Always persist the debug envelope so the last attempt can be
    // inspected regardless of success.
    await chrome.storage.local.set({
      [K.debug]: {
        ok:         result.ok,
        errorClass: result.errorClass || null,
        error:      result.error || null,
        debug:      result.debug || null,
        capturedAt: new Date().toISOString(),
      },
    });

    if (!result.ok) {
      // A failed capture must not leave a prior (possibly stale) payload on
      // screen looking fresh — clear it so the UI falls back to "no data"
      // plus the error freshness state.
      await chrome.storage.local.remove([K.rows, K.grandTotal]);
      await freshness.markError("stores", `${result.errorClass}: ${result.error}`);
      broadcast("source_complete", { sourceId: "stores", ok: false, error: result.error });
      return { ok: false, sourceId: "stores", errorClass: result.errorClass, error: result.error };
    }

    await chrome.storage.local.set({
      [K.rows]:       result.rows,
      [K.grandTotal]: result.grandTotal,
    });
    await freshness.markSuccess("stores");
    broadcast("source_complete", { sourceId: "stores", ok: true });
    return { ok: true, sourceId: "stores", storeCount: result.rows.length };
  } catch (e) {
    const err = String(e?.message ?? e);
    await freshness.markError("stores", err);
    broadcast("source_complete", { sourceId: "stores", ok: false, error: err });
    return { ok: false, sourceId: "stores", error: err };
  }
}

// ── Handler exports ─────────────────────────────────────────────────
export const handlers = {
  async "get_state"(_msg)   { return await getState(); },
  async "pull_stores"(_msg) { return await pullStores(); },
};
