// modules/stockingplan/service.js
//
// Service-worker handlers for the StockingPlan module.
// Uses raw chrome.storage with "stockingplan.*" prefix — host object is not
// available in SW context.
//
// Freight approach (rebuilt 2026-07-28, verified against live capture — see
// tools/FINDINGS.md):
//   1. Run main_search() in MAIN world to populate sessionStorage.
//   2. Read + LZString-decompress fpt_psnAPIJson (per-load, per-item freight),
//      fpt_mainJson (live cph, if any).
//   3. Fetch AisleLocation.ashx for the UPC->aisle fallback map.
//   4. Return { loads, liveCph, aisleMap } — all rollups happen in compute.js.

// --- MAIN-world function: search, then read decompressed sessionStorage -----
// Args: [storeNbr, businessDate "YYYY-MM-DD"]
// Relies on the CV page's own globals: main_search, LZString144, ajax3_toJson.

async function searchAndReadSession(storeNbr, businessDate) {
  const si = document.querySelector("#inpStoreNbr");
  const di = document.querySelector("#inpDate");
  if (!si) return { error: "inpStoreNbr not found" };
  si.value = String(storeNbr);
  if (di) di.value = String(businessDate);

  // Wait for the page's search fn to initialise (page script is async).
  const initDeadline = Date.now() + 15_000;
  while (typeof window.main_search !== "function" && Date.now() < initDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (typeof window.main_search !== "function") {
    return { error: "main_search not found after 15s — CV page may not have loaded" };
  }
  window.main_search();

  // Poll until the processing spinner hides (all AJAX done).
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  while (Date.now() - start < 25_000) {
    await new Promise((r) => setTimeout(r, 400));
    const el = document.querySelector("#divImgProcessing");
    if (!el || getComputedStyle(el).display === "none") break;
  }

  // sessionStorage isn't populated until the search's AJAX resolves — poll it.
  const decode = (key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    try { return window.ajax3_toJson(window.LZString144.decompress(raw)); }
    catch (e) { return { __decodeError: String(e) }; }
  };

  let loads = null;
  const dataDeadline = Date.now() + 15_000;
  while (Date.now() < dataDeadline) {
    loads = decode("fpt_psnAPIJson");
    if (Array.isArray(loads) && loads.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const mainJson = decode("fpt_mainJson");
  const liveCph = (mainJson && Array.isArray(mainJson.cph) && mainJson.cph.length)
    ? mainJson.cph : null;

  // Build plan-date metadata so compute.js can drop trailers that belong to a
  // different day (delivered-today / unload-tomorrow, canceled, or moved).
  // Mirrors the inputs to CV's psn_checkIncludeInPlanOrNot.
  let planMeta = null;
  if (mainJson) {
    const source = mainJson.api_for_shipments_source || "sfd";
    const trailerPayload = mainJson?.shipments?.data?.trailers?.payload || [];
    const trailers = [];
    for (const t of trailerPayload) {
      const stop = (t.stops && t.stops[0]) || {};
      const actual = stop.actualShipments || [];
      trailers.push({
        loadId: t.transLoadId,
        status: t.loadStatus,
        deliverByTs: stop.inductWindowEndTs || null,
        tz: stop.stopLocationTimeZone || null,
        hasActual: actual.length > 0,
        caseQtyNull: actual.length > 0 && actual[0].caseQuantity == null,
        pckQtyDefined: actual.length > 0 && typeof actual[0].pckQty !== "undefined",
      });
    }
    planMeta = {
      source,
      moved: (mainJson.shipments_moved || []).map((mv) => ({
        load_id: mv.load_id, unload_date: mv.unload_date,
      })),
      trailers,
    };
  }

  // Scrape the delivery schedule table for truck ETA/trailer/loadId. The
  // per-item freight comes from psn; this is only for the sidebar display.
  // Skip the header row AND the footer totals row (Bug B fix).
  const trucks = [];
  const deliveryTable = document.getElementById("summaryTableForDeliveries");
  if (deliveryTable) {
    const SUMMARY_RE = /^(grand\s*)?total|^summary/i;
    const toInt = (s) => parseInt(String(s || "0").replace(/,/g, "").replace(/-/g, "0"), 10) || 0;
    for (const row of deliveryTable.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll("td")].map((c) => c.textContent.trim());
      if (cells.length < 8) continue;                 // header (th) or malformed
      if (cells[0] === "Delivery ETA") continue;      // header
      if (SUMMARY_RE.test(cells[0]) || !cells[0]) continue; // footer totals / blank
      trucks.push({
        eta:        cells[0],
        type:       cells[1],
        trailer:    cells[2],
        loadId:     cells[3],
        grocCases:  toInt(cells[4]),
        gmCases:    toInt(cells[5]),
        bpCases:    toInt(cells[6]),
        totalCases: toInt(cells[7]),
        status:     row.textContent.includes("\u2713") ? "Arrived" : "",
      });
    }
  }

  // Fetch the aisle location map (UPC -> zone/aisle). Same-origin, cookies.
  let aisleMap = null;
  try {
    const r = await fetch(
      `../ashx/AisleLocation.ashx?func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=${encodeURIComponent(storeNbr)}`,
      { credentials: "include", headers: { Accept: "application/json" } }
    );
    if (r.ok) aisleMap = await r.json();
  } catch (_e) { /* aisle_loc on rows covers ~98%, map is a fallback */ }

  if (!Array.isArray(loads)) {
    return { error: "fpt_psnAPIJson not available after search", loads: [], liveCph, aisleMap, trucks, planMeta };
  }
  return { loads, liveCph, aisleMap, trucks, planMeta };
}

// --- Handlers ---------------------------------------------------------------

export const handlers = {
  async "collect-freight"(msg) {
    const { tabId, storeNbr, businessDate } = msg;
    if (!tabId) return { ok: false, error: "collect-freight: no tabId provided" };

    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: searchAndReadSession,
        args: [String(storeNbr), String(businessDate)],
      });

      const { loads = [], liveCph = null, aisleMap = null, trucks = [], planMeta = null, error } = res?.result ?? {};

      if (error && !loads.length) return { ok: false, error };

      return { ok: true, loads, liveCph, aisleMap, trucks, planMeta, warning: error || null };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};
