// modules/stockingplan/service.js
//
// Service-worker handlers for the StockingPlan module.
// Uses raw chrome.storage with "stockingplan.*" prefix — host object is not
// available in SW context (see AI_CONTEXT_BRIEF.md §2).
//
// Freight approach (confirmed via Playwright 2026-07-01):
//   1. Call window.main_search() in MAIN world (waits up to 15s for page JS init).
//   2. Poll until #divImgProcessing hides (~5s).
//   3. Read category totals from #summaryTableByArea already on the main page (no popup).
//   4. Open casesByAisle.html via window.open() — inherits window.opener for aisle data.
//      Wait readyState=complete + 2s buffer (table renders async after load).
//   5. Scrape aisle DOM and return {byDept, byAisle}.

import { createAuth, SSO_SELECTORS } from "../../shared/auth.js";

const MODULE_ID  = "stockingplan";
const CV_URL     = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";
const CV_HOST_RE = /^https:\/\/radapps3\.wal-mart\.com\/Protected\/CaseVisibility\//;

const auth = createAuth(MODULE_ID);

// --- MAIN-world async function (pure — no closure references) ---------------
// Args: [storeNbr: string, businessDate: string "YYYY-MM-DD"]

async function searchAndScrapeDetailed(storeNbr, businessDate) {
  // 1. Fill inputs. Wait for main_search to be initialized (page script is async).
  const si = document.querySelector("#inpStoreNbr");
  const di = document.querySelector("#inpDate");
  if (!si) return { byDept: [], byAisle: [], error: "inpStoreNbr not found" };
  si.value = String(storeNbr);
  if (di) di.value = String(businessDate);

  const initDeadline = Date.now() + 15_000;
  while (typeof window.main_search !== "function" && Date.now() < initDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (typeof window.main_search !== "function") {
    return { byDept: [], byAisle: [], error: "main_search not found after 15s — CV page may not have fully loaded" };
  }
  window.main_search();

  // 2. Poll until #divImgProcessing is hidden (all AJAX calls done, ~5s).
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  while (Date.now() - start < 20_000) {
    await new Promise((r) => setTimeout(r, 400));
    const el = document.querySelector("#divImgProcessing");
    if (!el || window.getComputedStyle(el).display === "none") break;
  }

  // 3. Category totals are already on the main page in #summaryTableByArea —
  //    no popup needed. Poll until it has rows (updates async after spinner hides).
  const byDept = [];
  const FC_RE   = /frozen|dairy|deli|meat|produce|fresh|consumables|food/i;
  const NAME_MAP = { Food: "Food (Non-FDD)" };
  const areaDeadline = Date.now() + 8_000;
  let areaTable;
  while (Date.now() < areaDeadline) {
    areaTable = document.getElementById("summaryTableByArea");
    if (areaTable && areaTable.querySelectorAll("tr td").length > 2) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (areaTable) {
    for (const row of areaTable.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll("td,th")].map((c) => c.textContent.trim());
      const cat = cells[0];
      if (!cat) continue;
      if (/^Cases by Area/i.test(cat)) continue;
      if (cells.length < 3 || !isNaN(Number(cat.replace(/,/g, "")))) continue;
      const cases = parseInt((cells[1] || "0").replace(/,/g, ""), 10) || 0;
      const bps   = parseInt((cells[2] || "0").replace(/,/g, ""), 10) || 0;
      byDept.push({
        category_name: NAME_MAP[cat] || cat,
        is_fc: FC_RE.test(cat),
        case_qty:  cases,
        bp_qty:    bps,
      });
    }
  }

  // 4. Open the aisle child window. It uses window.opener data populated by main_search.
  //    Playwright confirmed readyState=complete isn't enough — the table renders
  //    asynchronously, so we add a 2s buffer after load.
  const aisleWin = window.open("/Protected/CaseVisibility/html/casesByAisle.html", "_blank");

  async function waitReady(win, ms) {
    if (!win) return false;
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 300));
      try { if (win.document.readyState === "complete") return true; } catch {}
    }
    return false;
  }
  await waitReady(aisleWin, 15_000);
  await new Promise((r) => setTimeout(r, 2_000));  // async table-render buffer

  // 5. Scrape casesByAisle — columns confirmed via Playwright: [aisle, cases, time].
  //    No BP column; cells[2] is a time string. BP totals come from casesByDept.
  const byAisle = [];
  if (aisleWin && !aisleWin.closed) {
    for (const row of aisleWin.document.querySelectorAll("table tbody tr")) {
      const cells = [...row.querySelectorAll("td")].map((c) => c.textContent.trim());
      if (cells.length < 2) continue;
      const label = cells[0];
      if (!label || /^(Totals?|Store\b|Unknown|Case Details|^Aisle$)/i.test(label)) continue;
      const numMatch = label.match(/^A(\d+)$/);
      byAisle.push({
        aisle_nbr:   numMatch ? parseInt(numMatch[1], 10) : null,
        aisle_label: label,
        case_qty:    parseInt((cells[1] || "0").replace(/,/g, ""), 10) || 0,
        bp_qty:      0,
        dept_nbr:    92,
      });
    }
    try { aisleWin.close(); } catch {}
  }

  return { byDept, byAisle };
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

      const { byDept = [], byAisle = [], error } = res?.result ?? {};

      // Close any aisle/dept child tabs that window.open() left open — they
      // would be picked up as the "existing CV tab" on the next Collect run.
      const staleTabs = await chrome.tabs.query({
        url: "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/casesBy*",
      });
      for (const t of staleTabs) chrome.tabs.remove(t.id).catch(() => {});

      if (error && !byDept.length) return { ok: false, error };

      return { ok: true, byDept, byAisle };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },

  async "get-last-plan"(_msg) {
    return null;
  },
};
