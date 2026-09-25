// modules/stockingplan/service.js
//
// Service-worker handlers for the StockingPlan module.
// Uses raw chrome.storage with "stockingplan.*" prefix — host object is not
// available in SW context (see AI_CONTEXT_BRIEF.md §2).
//
// ── Why there are no pop-ups any more ─────────────────────────────────────
// The freight detail is shown by two child pages, casesByDept.html and
// casesByAisle.html, and the obvious way to scrape them is window.open from
// the CaseVisibility tab. Chrome focuses a window opened that way even when
// the opener is a background tab, so collecting yanked the user off the suite
// and onto CaseVisibility — twice.
//
// Neither child page has any data of its own. Both re-read `main_json` and
// `psn_apiJson` out of sessionStorage and then call functions that main.html
// has already loaded (calc.js, config.js, psn.js). So this runs their exact
// arithmetic in the main page instead:
//
//   casesByDept.html  →  buildDepts()   — same area lists, same
//                        calc_getCountsByDept + calc_getStockingHoursByDept,
//                        same psn_checkIncludeInPlanOrNot date filter
//   casesByAisle.html →  buildAisles()  — same AisleLocation.ashx POST, same
//                        dept 92/95 scope, same allowed shipment types
//
// Nothing is opened, nothing is focused, and the hours are still CaseVisibility's
// own rather than ours.

const MODULE_ID = "stockingplan";

// --- MAIN-world async function (pure — no closure references) ---------------
// Args: [storeNbr: string, businessDate: string "YYYY-MM-DD"]

async function searchAndScrapeDetailed(storeNbr, businessDate) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toInt = (txt) => {
    const v = String(txt || "").replace(/,/g, "").trim();
    if (!v || v === "-") return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  };
  // CaseVisibility works in decimal hours internally and prints H:MM. The
  // module carries minutes, so everything is converted once, here.
  const toMin = (hours) => Math.round((Number(hours) || 0) * 60);

  // 1. Fill inputs. Wait for main_search to be initialized (page script is async).
  const si = document.querySelector("#inpStoreNbr");
  const di = document.querySelector("#inpDate");
  if (!si) return { error: "inpStoreNbr not found" };
  si.value = String(storeNbr);
  if (di) di.value = String(businessDate);

  const initDeadline = Date.now() + 15_000;
  while (typeof window.main_search !== "function" && Date.now() < initDeadline) {
    await sleep(200);
  }
  if (typeof window.main_search !== "function") {
    return { error: "main_search not found after 15s — CV page may not have fully loaded" };
  }
  window.main_search();

  // 2. Poll until #divImgProcessing is hidden (all AJAX calls done, ~5s).
  const start = Date.now();
  await sleep(300);
  while (Date.now() - start < 20_000) {
    await sleep(400);
    const el = document.querySelector("#divImgProcessing");
    if (!el || window.getComputedStyle(el).display === "none") break;
  }

  // psn_apiJson is filled by the per-load details API, which lands a beat after
  // the spinner clears.
  const jsonDeadline = Date.now() + 10_000;
  while (Date.now() < jsonDeadline) {
    if (Array.isArray(window.psn_apiJson) && window.psn_apiJson.length) break;
    await sleep(400);
  }

  // 3. Area roll-up — already rendered on the main page.
  const areas   = [];
  const FC_RE   = /frozen|dairy|deli|meat|produce|fresh|consumables|food/i;
  const NAME_MAP = { Food: "Food (Non-FDD)" };
  const areaDeadline = Date.now() + 8_000;
  let areaTable;
  while (Date.now() < areaDeadline) {
    areaTable = document.getElementById("summaryTableByArea");
    if (areaTable && areaTable.querySelectorAll("tr td").length > 2) break;
    await sleep(300);
  }
  if (areaTable) {
    for (const row of areaTable.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll("td,th")].map((c) => c.textContent.trim());
      const cat = cells[0];
      if (!cat) continue;                                   // trailing totals row has no label
      if (/^Cases by Area/i.test(cat)) continue;            // header
      if (cells.length < 3 || !isNaN(Number(cat.replace(/,/g, "")))) continue;
      areas.push({
        area_name: NAME_MAP[cat] || cat,
        is_fc:     FC_RE.test(cat),
        case_qty:  toInt(cells[1]),
        bp_qty:    toInt(cells[2]),
      });
    }
  }

  // ── the date casesByDept/casesByAisle filter loads against ──────────────
  // Both child pages derive it the same way. Fall back to formatting the
  // requested date ourselves if session storage hasn't been written yet.
  function planDate() {
    try {
      const fromSession = cmn_getDateString("m/d/yyyy", ss_get("fpt_businessDate"));
      if (fromSession) return fromSession;
    } catch { /* helper missing or nothing stored */ }
    const m = String(businessDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : String(businessDate);
  }
  const gvDate = planDate();

  // CaseVisibility declares its functions with `function` (so they land on
  // window) but its department tables with `let`/`const` — which are lexical
  // globals and NOT window properties. Reading config_deptGrocFDD off window
  // returns undefined, and grocery, frozen/dairy and meat/produce silently
  // came back empty. Bare identifiers resolve against the global lexical
  // scope, so everything below is read that way, guarded with typeof.
  const lex = {
    grocFDD:   typeof config_deptGrocFDD          !== "undefined" ? config_deptGrocFDD          : null,
    meatFresh: typeof config_deptMeatProduceFresh !== "undefined" ? config_deptMeatProduceFresh : null,
    grocNon:   typeof config_deptGrocNonFDD       !== "undefined" ? config_deptGrocNonFDD       : null,
  };

  const haveCalc =
    typeof calc_getCountsByDept === "function" &&
    typeof calc_getStockingHoursByDept === "function" &&
    typeof psn_checkIncludeInPlanOrNot === "function" &&
    Array.isArray(window.psn_apiJson);

  // 4. Per-department breakdown — casesByDept.html's own loop.
  const depts     = [];
  const areaTimes = [];
  let deptError   = null;

  if (!haveCalc) {
    deptError = "CaseVisibility's calc/config helpers weren't loaded — department detail unavailable";
  } else {
    try {
      // The same seven area buckets, in the same order, from the same config
      // calls the child page makes.
      const AREA_SETS = [
        ["General Merchandise", config_getDeptNbrsByAreas("Hardlines,Homelines,Entertainment,Other")],
        ["Fashion",             config_getDeptNbrsByArea("Fashion")],
        ["Seasonal",            config_getDeptNbrsByArea("Seasonal")],
        ["Frozen/Dairy/Deli",   lex.grocFDD],
        ["Meat/Produce/Fresh",  lex.meatFresh],
        ["Food (Non-FDD)",      lex.grocNon],
        ["Consumables",         config_getDeptNbrsByArea("Consumables")],
      ];

      const missingSets = AREA_SETS.filter(([, v]) => !Array.isArray(v)).map(([n]) => n);
      if (missingSets.length) {
        throw new Error("CaseVisibility department lists missing for: " + missingSets.join(", "));
      }

      const included = window.psn_apiJson.filter(
        (l) => psn_checkIncludeInPlanOrNot(l.load_id, gvDate) !== false,
      );

      for (const [areaName, deptNbrs] of AREA_SETS) {
        if (!Array.isArray(deptNbrs)) continue;
        let aCases = 0, aBps = 0, aCaseH = 0, aBpH = 0;

        for (const deptNbr of deptNbrs) {
          let cases = 0, bps = 0, caseH = 0, bpH = 0;
          for (const load of included) {
            const c = calc_getCountsByDept(load.load_id, deptNbr);
            cases += c[0];
            bps   += c[1];
            caseH += calc_getStockingHoursByDept(c[0], deptNbr);
            bpH   += calc_getStockingHoursByDept(c[1], deptNbr);
          }
          if (cases <= 0 && bps <= 0) continue;   // the child page skips empty depts

          depts.push({
            area_name: areaName,
            is_fc:     FC_RE.test(areaName),
            dept_nbr:  deptNbr,
            dept_name: (() => {
              try { return String(config_getDeptName(deptNbr) || ""); } catch { return ""; }
            })(),
            case_qty:  cases,
            case_min:  toMin(caseH),
            bp_qty:    bps,
            bp_min:    toMin(bpH),
            total_min: toMin(caseH + bpH),
          });

          aCases += cases; aBps += bps; aCaseH += caseH; aBpH += bpH;
        }

        if (aCases > 0 || aBps > 0) {
          areaTimes.push({
            area_name: areaName,
            case_qty:  aCases,
            case_min:  toMin(aCaseH),
            bp_qty:    aBps,
            bp_min:    toMin(aBpH),
            total_min: toMin(aCaseH + aBpH),
          });
        }
      }
    } catch (e) {
      deptError = "department breakdown failed: " + String(e?.message ?? e);
    }
  }

  // 5. D92/95 by aisle — casesByAisle.html's own logic, without the window.
  const aisles   = [];
  const trailers = [];
  let aisleError = null;

  if (haveCalc) {
    try {
      const LOC_DEPTS = [92, 95];
      // The child page ignores shipment types that never carry grocery.
      const ALLOWED = ["RDC", "HVDC", "MP", "MPDD", "F", "FDD", "MK", "MILK", "CANDY"];

      const included = window.psn_apiJson.filter(
        (l) => psn_checkIncludeInPlanOrNot(l.load_id, gvDate) !== false &&
               ALLOWED.includes(l.shipment_type),
      );

      const upcs = new Set();
      for (const load of included) {
        for (const d of load.shipment_details || []) {
          if (LOC_DEPTS.includes(d.dept_nbr)) upcs.add(parseInt(d.gtin_nbr, 10));
        }
      }

      if (upcs.size) {
        const resp = await fetch(
          `/Protected/CaseVisibility/ashx/AisleLocation.ashx?func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=${encodeURIComponent(storeNbr)}`,
          {
            method:      "POST",
            credentials: "include",
            headers:     { "Content-Type": "application/x-www-form-urlencoded" },
            body:        "upcList=" + [...upcs].join(","),
          },
        );
        if (!resp.ok) throw new Error(`AisleLocation ${resp.status}`);
        const loc = await resp.json();

        // upc → "A8". Items with several locations show on one aisle, as the
        // child page's own footnote says, so first write wins.
        const upcAisle = new Map();
        for (const l of loc.locations || []) {
          const k = parseInt(l.upc_nbr, 10);
          if (!upcAisle.has(k)) upcAisle.set(k, `${l.zone}${l.aisle}`);
        }

        // psn_apiJson rows carry load_id but NOT trailer_id, so the per-trailer
        // note was printing load IDs. The store talks in trailer numbers — the
        // aisle page's own column headings read "RDC 153857" — and main_json.sdl
        // is where the pairing lives.
        const trailerOf = new Map();
        for (const d of (typeof main_json !== "undefined" && main_json?.sdl) || []) {
          if (d.load_id != null && d.trailer_id != null) trailerOf.set(String(d.load_id), String(d.trailer_id));
        }

        const rows = new Map();   // label → { cases, hours, byTrailer:Map }
        const rowFor = (label) => {
          if (!rows.has(label)) rows.set(label, { cases: 0, hours: 0, byTrailer: new Map() });
          return rows.get(label);
        };

        for (const load of included) {
          const tLabel = `${load.shipment_type} ${trailerOf.get(String(load.load_id)) ?? load.load_id}`;
          let sawTrailer = false;

          for (const d of load.shipment_details || []) {
            if (!LOC_DEPTS.includes(d.dept_nbr)) continue;
            const cases = Number(d.full_cases) || 0;
            if (cases <= 0) continue;

            const label = upcAisle.get(parseInt(d.gtin_nbr, 10)) || "Unknown";
            const hours = calc_getStockingHoursByDept(cases, d.dept_nbr);
            const row   = rowFor(label);
            row.cases += cases;
            row.hours += hours;

            const t = row.byTrailer.get(tLabel) || { trailer: tLabel, case_qty: 0, min: 0 };
            t.case_qty += cases;
            t.min      += toMin(hours);
            row.byTrailer.set(tLabel, t);
            sawTrailer = true;
          }
          if (sawTrailer && !trailers.includes(tLabel)) trailers.push(tLabel);
        }

        for (const [label, row] of rows) {
          const m = label.match(/^A(\d+)$/i);
          aisles.push({
            aisle_nbr:   m ? parseInt(m[1], 10) : null,
            aisle_label: label,
            unknown:     label === "Unknown",
            case_qty:    row.cases,
            total_min:   toMin(row.hours),
            bp_qty:      0,        // the aisle view is full cases only
            dept_nbr:    92,       // D92/95 combined, as the page titles it
            by_trailer:  [...row.byTrailer.values()].sort((a, b) => b.case_qty - a.case_qty),
          });
        }
      }
    } catch (e) {
      aisleError = "aisle breakdown failed: " + String(e?.message ?? e);
    }
  }

  return {
    areas, depts, areaTimes, aisles, trailers,
    error: [deptError, aisleError].filter(Boolean).join("; ") || null,
  };
}

// --- Handlers ---------------------------------------------------------------

export const handlers = {
  async "collect-freight"(msg) {
    const { tabId, storeNbr, businessDate } = msg;
    if (!tabId) return { ok: false, error: "collect-freight: no tabId provided" };

    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world:  "MAIN",
        func:   searchAndScrapeDetailed,
        args:   [String(storeNbr), String(businessDate)],
      });

      const {
        areas = [], depts = [], areaTimes = [], aisles = [], trailers = [], error,
      } = res?.result ?? {};

      if (error && !areas.length && !depts.length) return { ok: false, error };

      return {
        ok: !error,
        areas, depts, areaTimes, aisles, trailers,
        // Partial captures are possible (the aisle API can fail on its own) —
        // say which parts made it so the view can warn instead of going blank.
        captured: {
          areas:  areas.length,
          depts:  depts.length,
          aisles: aisles.length,
        },
        error: error || null,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },

  async "get-last-plan"(_msg) {
    const key = `${MODULE_ID}.lastPlan`;
    const got = await chrome.storage.local.get(key);
    return got?.[key] ?? null;
  },

  async "save-last-plan"(msg) {
    const key = `${MODULE_ID}.lastPlan`;
    await chrome.storage.local.set({ [key]: msg?.plan ?? null });
    return { ok: true };
  },
};
