// modules/costinventory/service.js
//
// Service-worker handlers for the Cost Inventory calculator.
//
// One pull touches four unrelated systems, each with its own auth:
//
//   OneWalmart    beginning inventory   cookie + a CSRF header
//   Ops Portal    sales and purchases   cookie, one tRPC GET per department
//   CaseVisibility which trailers, MP or FDD   a MAIN-world read of an open tab
//   GDP Connect   what the trailers cost   a captured Bearer token
//
// They are pulled concurrently and failures are per-source: a dead ITR session
// must not throw away a good trailer read, because the store is standing at the
// worksheet trying to finish a count. Every source reports its own status and
// the UI shows which half landed.
//
// Uses raw chrome.storage with the "costinventory.*" prefix — the host object
// does not exist in SW context (AI_CONTEXT_BRIEF.md §2).

import { createAuth } from "../../shared/auth.js";
import { inventoryWindow, previousNight, shiftDays } from "./lib/dates.js";
import { withTimeout } from "./lib/timeout.js";
import { fetchBeginningInventory } from "./lib/onewalmart.js";
import { fetchDeptDays, sumWindow } from "./lib/itr.js";
import { fetchFreshLoads } from "./lib/casevisibility.js";
import { fetchTrailerCosts } from "./lib/gdp.js";
import { buildWorksheet, buildTrailerPanel, DEPT_NUMBERS } from "./lib/compute.js";

const MODULE_ID = "costinventory";

const K = {
  snapshot: "costinventory.snapshot",
  inputs:   "costinventory.inputs.v1",
};

// The dashboard's own token is a short-lived PingFed JWT. Half an hour is well
// inside its life and short enough that a stale one is not replayed all day.
const GDP_TOKEN_KEY = "gdp.bearer";
const GDP_TOKEN_TTL_MS = 30 * 60 * 1000;
const GDP_DASHBOARD_URL = "https://gdp-connect.walmart.com/user/projects/20/dashboards/351";

// A trailer that lands on the night of the 21st can carry an invoice dated the
// 20th, and occasionally the paperwork trails by longer. The trailer list is
// what makes the query exact, so the date range only has to be wide enough not
// to clip it.
const INVOICE_LOOKBACK_DAYS = 14;
const INVOICE_LOOKAHEAD_DAYS = 3;

const auth = createAuth(MODULE_ID);
const gdpToken = auth.getCapturedHeader(GDP_TOKEN_KEY, GDP_TOKEN_TTL_MS);

export const handlers = {
  async "get_state"() {
    const got = await chrome.storage.local.get([K.snapshot, K.inputs]);
    return {
      ok: true,
      snapshot: got[K.snapshot] ?? null,
      inputs: got[K.inputs] ?? { storeNbr: "", counted: {} },
      defaults: defaultDates(),
    };
  },

  /** Persist what the user typed: the store, and the Cost Inventory App counts. */
  async "set_inputs"(msg) {
    const got = await chrome.storage.local.get(K.inputs);
    const next = { ...(got[K.inputs] ?? { storeNbr: "", counted: {} }), ...(msg?.inputs ?? {}) };
    await chrome.storage.local.set({ [K.inputs]: next });
    return { ok: true, inputs: next };
  },

  async "pull"(msg) {
    const storeNbr = String(msg?.storeNbr ?? "").trim();
    if (!/^\d{1,5}$/.test(storeNbr)) return { ok: false, error: "enter a store number first" };

    const dates = { ...defaultDates(), ...(msg?.dates ?? {}) };
    const counted = msg?.counted ?? {};

    const [beginning, itr, trailers] = await Promise.all([
      settle(() => pullBeginningInventory(storeNbr)),
      settle(() => pullItr(storeNbr, dates.windowStart, dates.windowEnd)),
      settle(() => pullTrailers(storeNbr, dates.night)),
    ]);

    // Freight is deliberately NOT passed in: row 8 stays zero and the trailer
    // figures live in their own panel (see lib/compute.js).
    const worksheet = buildWorksheet({
      counted,
      beginningInventory: beginning.value?.byDept ?? {},
      itrByDept: itr.value?.byDept ?? {},
    });

    const snapshot = {
      storeNbr,
      dates,
      pulledAt: Date.now(),
      worksheet,
      trailerPanel: trailers.value?.panel ?? null,
      sources: {
        beginningInventory: sourceStatus(beginning, {
          tool: beginning.value?.heading ?? null,
          lastUpdated: beginning.value?.lastUpdated ?? null,
        }),
        itr: sourceStatus(itr, { coverage: itr.value?.coverage ?? null }),
        trailers: sourceStatus(trailers, {
          night: dates.night,
          loads: trailers.value?.loads ?? [],
        }),
      },
    };

    await chrome.storage.local.set({ [K.snapshot]: snapshot });
    return { ok: true, snapshot };
  },

  /** Re-read just the trailers — the half that changes every night. */
  async "pull_trailers"(msg) {
    const storeNbr = String(msg?.storeNbr ?? "").trim();
    const night = msg?.night ?? previousNight();
    try {
      const { panel, loads } = await pullTrailers(storeNbr, night);
      return { ok: true, panel, loads, night };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

// ─── per-source pulls ─────────────────────────────────────────────────────

async function pullBeginningInventory(storeNbr) {
  return await fetchBeginningInventory(storeNbr);
}

async function pullItr(storeNbr, start, end) {
  const results = await Promise.all(DEPT_NUMBERS.map(async (dept) => {
    const days = await fetchDeptDays(storeNbr, dept);
    return [dept, sumWindow(days, start, end)];
  }));

  const byDept = Object.fromEntries(results);
  // Coverage is the same for every department; report one.
  return { byDept, coverage: results[0]?.[1]?.coverage ?? null };
}

async function pullTrailers(storeNbr, night) {
  const loads = await fetchFreshLoads(storeNbr, night);
  if (!loads.length) return { panel: buildTrailerPanel([], []), loads };

  const costRows = await withGdpTab(async (runQuery) => await fetchTrailerCosts({
    runQuery,
    storeNbr,
    trailers: loads.map((l) => l.trailer),
    startDate: shiftDays(night, -INVOICE_LOOKBACK_DAYS),
    endDate:   shiftDays(night, INVOICE_LOOKAHEAD_DAYS),
  }));

  return { panel: buildTrailerPanel(loads, costRows), loads };
}

/**
 * Run GDP queries from inside a gdp-connect.walmart.com tab.
 *
 * The query API cannot be called from the extension origin at all — see the
 * note in lib/gdp.js — so the tab is not an optimisation, it is the transport.
 * The Authorization header still comes from the captured token rather than
 * from the page, because the dashboard keeps its own copy in a closure where
 * nothing outside its bundle can reach it.
 */
async function withGdpTab(fn) {
  // A FRESH tab every time, never a reused one. Edge freezes long-lived
  // background tabs, and chrome.scripting.executeScript against a frozen tab
  // does not fail — it hangs forever, taking the whole pull with it. (Same
  // trap as the vizpick capture tabs.) A tab opened seconds ago cannot be
  // frozen yet.
  const tab = await chrome.tabs.create({ url: GDP_DASHBOARD_URL, active: false });

  try {
    await waitForGdpPage(tab.id);
    // The token usually arrives from this very tab's first query.
    const bearer = await ensureGdpToken();

    const runQuery = async (url, bodyJson) => {
      const [{ result }] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: postFromPage,
          args: [url, bodyJson, bearer],
        }),
        60_000,
        "the GDP dashboard tab stopped responding");
      if (result?.error) throw new Error(result.error);
      return result;
    };

    return await fn(runQuery);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// MAIN-world: the page's own fetch, so this is a same-site call with the
// page's cookies. Pure — it may not close over anything out here.
async function postFromPage(url, bodyJson, bearer) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": bearer,
        "x-gdp-request-id": "apaisuite-" + Date.now(),
      },
      body: bodyJson,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { error: "GDP request failed inside the dashboard tab: " + String(e?.message ?? e) };
  }
}

async function waitForGdpPage(tabId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => /gdp-connect\.walmart\.com/.test(location.host) && document.readyState !== "loading",
        }),
        10_000,
        "GDP tab did not answer");
      if (result) return;
    } catch { /* navigating, or an SSO hop — try again */ }
    await sleep(750);
  }
  throw new Error("GDP Connect did not finish loading in 60s");
}

/**
 * The token is captured from the dashboard's own traffic by the shell's
 * declarative webRequest filter, so it appears shortly after the tab this runs
 * beside has loaded and fired its first query.
 */
async function ensureGdpToken() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const token = gdpToken.get();
    if (token) return token;
    await sleep(1000);
  }
  throw new Error(
    "GDP Connect did not hand over a token in 45s — open the Warehouse Details dashboard " +
    "yourself, confirm it loads, then pull again");
}

// ─── helpers ──────────────────────────────────────────────────────────────

function defaultDates() {
  const { start, end } = inventoryWindow();
  return { windowStart: start, windowEnd: end, night: previousNight() };
}

/** Run a pull, capturing failure instead of letting it sink the others. */
async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function sourceStatus(result, extra = {}) {
  return { ok: result.ok, error: result.ok ? null : result.error, ...extra };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
