// modules/costinventory/lib/casevisibility.js
//
// Which trailers landed last night, and whether each one is MP or FDD.
//
// GDP knows what every trailer cost but not what kind of trailer it was — both
// MP and FDD ship from the same perishable DC (6062 for store 1458), so the DC
// number cannot separate them. CaseVisibility is the only source that labels
// them, in `main_json.sdl[].shipment_type`, paired with `trailer_id` — and
// CV's `trailer_id` is the same number GDP calls `Trailer_Nbr` (verified: MP
// 322594 and FDD 309178 on the night of 2026-09-21).
//
// The CV read follows `stockingplan/service.js`: fill the store/date inputs in
// the MAIN world, call the page's own `main_search()`, wait for its spinner,
// then read `main_json`. Nothing is opened in a popup — CV's child pages steal
// focus, and they hold no data of their own anyway.

import { withTimeout, tabResponds } from "./timeout.js";

const CV_URL = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";

// The fresh shipment types. Everything else on a night's manifest (RDC, HVDC,
// MILK, CANDY) is grocery/GM freight and is not part of the fresh count, so
// those trailers are dropped rather than shown as "other".
export const FRESH_SHIPMENT_TYPES = Object.freeze(["MP", "MPDD", "FDD"]);

export class CaseVisibilityError extends Error {}

/**
 * Fresh loads for one store and business date.
 * @returns {Promise<Array<{ type, trailer, loadId, scheduled, estimated, actual, cases }>>}
 */
export async function fetchFreshLoads(storeNbr, businessDate) {
  const { tabId, opened } = await findOrOpenCvTab();

  try {
    // Generous but finite: the search itself polls CV's spinner for up to 25s
    // inside the page, so anything past 90s means the tab is wedged.
    const [{ result }] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: cvSearchAndRead,
        args: [String(storeNbr), String(businessDate)],
      }),
      90_000,
      "CaseVisibility stopped responding during the search");

    if (result?.error) throw new CaseVisibilityError(result.error);

    const loads = (result?.loads ?? [])
      .filter((l) => FRESH_SHIPMENT_TYPES.includes(l.type))
      .map((l) => ({ ...l, trailer: String(l.trailer) }));

    return loads;
  } finally {
    // Only clean up a tab we opened ourselves; the user's own CV tab stays put.
    if (opened) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function findOrOpenCvTab() {
  // An existing CV tab is worth reusing — it is already past SSO — but only
  // if it is actually alive. A tab the browser froze answers nothing, and
  // reusing one wedges the pull.
  const existing = await chrome.tabs.query({ url: "https://radapps3.wal-mart.com/Protected/CaseVisibility/*" });
  for (const tab of existing) {
    if (await tabResponds(tab.id)) {
      await waitForSearchForm(tab.id);
      return { tabId: tab.id, opened: false };
    }
  }

  const tab = await chrome.tabs.create({ url: CV_URL, active: false });
  await waitForSearchForm(tab.id);
  return { tabId: tab.id, opened: true };
}

/**
 * Wait for the search form, not for the tab.
 *
 * `chrome.tabs.get().status` is the obvious signal and the wrong one here: CV
 * holds a request open, so the tab can sit at "loading" long after the page is
 * fully usable, and a status-based wait times out on a page that is sitting
 * there ready. Polling for the input the search actually needs is both faster
 * and truthful.
 */
async function waitForSearchForm(tabId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await probe(tabId);
    if (ready === "ready") return;
    if (ready === "sso") {
      // Mid-SSO redirect — the form will appear once the hop lands.
      await sleep(1500);
      continue;
    }
    await sleep(750);
  }
  throw new CaseVisibilityError(
    "CaseVisibility did not present its search form within 60s — open " +
    "radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html and sign in, then retry");
}

async function probe(tabId) {
  try {
    const [{ result }] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      // Runs in the ISOLATED world, which shares the DOM but NOT the page's
      // globals — so this checks for the input and leaves "has main_search
      // finished initialising?" to the MAIN-world function below, which waits
      // for it anyway. Testing `window.main_search` here reads as undefined
      // forever and the wait never ends.
      func: () => {
        if (document.querySelector("#inpStoreNbr")) return "ready";
        if (/pfedprod|login|saml/i.test(location.href)) return "sso";
        return "waiting";
      },
    }), 8000, "CaseVisibility tab did not answer");
    return result;
  } catch {
    // Script injection fails while a navigation is in flight; that is a
    // "not yet", not a failure.
    return "waiting";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MAIN-world function ──────────────────────────────────────────────────
// Serialized into the page, so it may not close over anything out here.
async function cvSearchAndRead(storeNbr, businessDate) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const storeInput = document.querySelector("#inpStoreNbr");
  const dateInput  = document.querySelector("#inpDate");
  if (!storeInput) return { error: "CaseVisibility store input not found — is the page still loading?" };

  storeInput.value = String(storeNbr);
  if (dateInput) dateInput.value = String(businessDate);

  const initDeadline = Date.now() + 15_000;
  while (typeof window.main_search !== "function" && Date.now() < initDeadline) await sleep(200);
  if (typeof window.main_search !== "function") {
    return { error: "CaseVisibility main_search() never appeared — page did not finish loading" };
  }

  window.main_search();
  await sleep(500);

  // Spinner down == every AJAX call for the search has returned.
  const spinnerDeadline = Date.now() + 25_000;
  while (Date.now() < spinnerDeadline) {
    await sleep(400);
    const el = document.querySelector("#divImgProcessing");
    if (!el || window.getComputedStyle(el).display === "none") break;
  }
  await sleep(1200);

  const sdl = (typeof main_json !== "undefined" && main_json?.sdl) || [];
  if (!sdl.length) {
    return { error: "CaseVisibility returned no loads for store " + storeNbr + " on " + businessDate };
  }

  return {
    loads: sdl.map((d) => ({
      type:      d.shipment_type,
      trailer:   d.trailer_id,
      loadId:    d.load_id,
      scheduled: d.sched_delivery_ts ?? null,
      estimated: d.est_delivery_ts ?? null,
      actual:    d.actual_delivery_ts ?? null,
      cases:     Number(d.total_cases) || 0,
    })),
  };
}
