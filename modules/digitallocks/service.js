// modules/digitallocks/service.js
//
// Service-worker handlers for digitallocks. V1.5 uses a capture-and-replay
// strategy against Power BI's underlying DAX query endpoint, bypassing the
// fragile UI export flow entirely.
//
// V2 adds:
//   lookupUpcOrders  — replays GScope OMS orders endpoint for UPC cross-check.
//                      Reads auth headers captured by content/gscope_capture.js.
//   lookupAssociate  — scrapes One Wire directory for associate tenure context.
//
// Flow (Power BI):
//   1. ensurePowerBiTab           find or create a background app.powerbi.com tab
//   2. waitForCapture             poll until the MAIN-world capture
//                                 (content/capture.js) has recorded a
//                                 data-grid DAX request. The user must let
//                                 the report load once so the visual fires
//                                 its initial query.
//   3. mutate body                substitute the desired store into the
//                                 captured query's Where clause
//   4. POST from SW               (no cookies needed; MWCToken in
//                                 captured Authorization header is self-
//                                 contained auth)
//   5. decodeDsr(response)        Power BI's compressed Data Shape Result
//                                 → flat row objects keyed by column name
//   6. return rows                view feeds them into the same scoring /
//                                 persistence pipeline as the manual XLSX
//                                 import.

import { ensureAlarm } from "../../shared/alarms.js";
import { findOrOpenTracked, closeIfOpened } from "../../shared/tabs.js";
import * as Directory from "../../shared/associateDirectory.js";
import { lookupTitle } from "../../shared/associateLookup.js";
import { decodeDsr } from "./lib/dsrDecode.js";
import { classifyAuthResponse, isAuthFailureStatus, reloadTabAndWait } from "../../shared/auth.js";
import { fetchAllLocksFromPage } from "./lib/buildCaseMap.js";
import { fetchAllUsersFromPage, deleteUserFromPage } from "./lib/fetchAllUsersFromPage.js";

const MODULE_ID = "digitallocks";
const POWER_BI_URL = "https://app.powerbi.com/groups/me/reports/a118e7e7-9431-4240-b630-04575d36cc37/217785fb10b56ddae020?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi";
const REPORT_TAB_FILTER = "https://app.powerbi.com/groups/me/reports/a118e7e7-9431-4240-b630-04575d36cc37/*";

const STORE_KEY         = "digitallocks.homeStore";
const AUTO_REFRESH_KEY  = "digitallocks.autoRefresh";
const DAILY_ALARM_NAME  = "digitallocks.daily-refresh";

// Idempotent — see shared/alarms.js. This used to call chrome.alarms.create()
// unconditionally from module.js::register(), which runs on every shell page
// load; each load cancelled the pending alarm and restarted the 24-hour
// countdown, so for anyone who opened the suite daily it could never fire.
export function installDailyRefreshAlarm() {
  return ensureAlarm(DAILY_ALARM_NAME, {
    delayInMinutes:  24 * 60,
    periodInMinutes: 24 * 60,
  });
}

export async function onAlarm(alarm) {
  if (alarm.name !== DAILY_ALARM_NAME) return;
  const stored = await chrome.storage.local.get(STORE_KEY).catch(() => ({}));
  const storeNumber = stored[STORE_KEY];
  if (!storeNumber) {
    console.log("[digitallocks] daily refresh: no home store saved — skipping");
    return;
  }
  console.log(`[digitallocks] daily refresh for store ${storeNumber}`);
  try {
    // Re-use the full searchByStore pipeline (opens Power BI tab if not already open).
    const result = await handlers.searchByStore({ storeNumber, openIfMissing: false, waitMs: 120_000 });
    if (result?.ok && result.rows?.length) {
      await chrome.storage.local.set({
        [AUTO_REFRESH_KEY]: { storeNumber, rows: result.rows, refreshedAt: Date.now() },
      });
      console.log(`[digitallocks] daily refresh stored ${result.rows.length} rows for view pick-up`);
    } else {
      console.warn("[digitallocks] daily refresh: no rows or failed —", result?.error ?? "unknown");
    }
  } catch (e) {
    console.warn("[digitallocks] daily refresh failed:", e?.message ?? e);
  }
}
const GSCOPE_ORDER_URL = "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution";
const OMS_BASE = "https://gscope.walmartlabs.com/api/gateway/provider-oms/orders";
const WORKDAY_ORIGIN = "https://wd504.myworkday.com";
const WORKDAY_SEARCH = `${WORKDAY_ORIGIN}/walmart/d/search.htmld?q=`;

// Autonomous-reauth attempts when Power BI returns 401 / login HTML.
const MAX_REAUTH_ATTEMPTS = 2;

// Associate tenure is cached PERMANENTLY in shared/associateDirectory.js, not
// here. The old module-local cache (`digitallocks.assoc.<win>`, 24 h TTL) meant
// the same associates were re-scraped from Workday every day, and nothing else
// in the suite could see the result. Stale keys from that cache are harmless
// and unread; the suite has unlimitedStorage.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const handlers = {
  ping: async () => ({ pong: true, at: Date.now() }),

  // ── InVue case-map export ─────────────────────────────────────────────────

  // buildCaseMap()
  //   -> { ok, locks: LockRecord[], count: number }
  //
  // Finds the user's active InVue /app/locks tab (or opens it) and injects
  // fetchAllLocksFromPage via executeScript (world: MAIN, same-origin fetch).
  // The view calls buildCaseMapXlsx() on the returned array and downloads it.
  async buildCaseMap(_msg) {
    const INVUE_MATCH = "https://prod.liveaccess.invue.walmart.com/app/locks*";
    const INVUE_URL   = "https://prod.liveaccess.invue.walmart.com/app/locks";

    // If the user already has InVue open we borrow their tab and leave it
    // alone; if we open one it's ours to close, including on the throw paths
    // below (a failed injection used to leave a tab behind every attempt).
    const state = await findOrOpenTracked(INVUE_URL, { match: INVUE_MATCH });
    try {
      if (state.opened) await waitForTabLoad(state.tab.id, 20_000);

      let result;
      try {
        result = await chrome.scripting.executeScript({
          target: { tabId: state.tab.id },
          world: "MAIN",
          func: fetchAllLocksFromPage,
        });
      } catch (e) {
        throw new Error(`InVue script injection failed: ${e?.message ?? e}. Make sure the InVue Locks page is loaded and you are logged in.`);
      }

      const locks = result?.[0]?.result;
      if (!Array.isArray(locks)) {
        throw new Error("InVue page returned no lock data — ensure you are logged into prod.liveaccess.invue.walmart.com.");
      }
      return { ok: true, locks, count: locks.length };
    } finally {
      await closeIfOpened(state);
    }
  },

  // ── InVue user audit ──────────────────────────────────────────────────────

  // fetchInvueUsers()
  //   -> { ok, users: UserRecord[], count }
  //
  // Finds or opens the InVue /app/users tab and injects fetchAllUsersFromPage.
  // Each UserRecord is the raw InVue API object — includes id (internal) and
  // a WIN field (username / userId / employeeId — confirmed on first real run).
  async fetchInvueUsers(_msg) {
    const INVUE_MATCH = "https://prod.liveaccess.invue.walmart.com/app/*";
    const INVUE_URL   = "https://prod.liveaccess.invue.walmart.com/app/users";

    const state = await findOrOpenTracked(INVUE_URL, { match: INVUE_MATCH });
    try {
      if (state.opened) await waitForTabLoad(state.tab.id, 20_000);

      let result;
      try {
        result = await chrome.scripting.executeScript({
          target: { tabId: state.tab.id },
          world:  "MAIN",
          func:   fetchAllUsersFromPage,
        });
      } catch (e) {
        throw new Error(`InVue user fetch failed: ${e?.message ?? e}. Ensure you are logged into InVue.`);
      }

      const users = result?.[0]?.result;
      if (!Array.isArray(users)) {
        throw new Error("InVue returned no user data — ensure you are logged into prod.liveaccess.invue.walmart.com.");
      }
      return { ok: true, users, count: users.length };
    } finally {
      await closeIfOpened(state);
    }
  },

  // deleteInvueUser({ invueUserId })
  //   -> { ok: true }
  //
  // Injects a same-origin DELETE /appv1/users/{id} into the open InVue tab.
  async deleteInvueUser(msg) {
    const invueUserId = msg?.invueUserId;
    if (!invueUserId) throw new Error("invueUserId required");

    const INVUE_MATCH = "https://prod.liveaccess.invue.walmart.com/app/*";
    const tabs = await chrome.tabs.query({ url: INVUE_MATCH });
    if (!tabs.length) throw new Error("No InVue tab open — fetch users first.");

    let result;
    try {
      result = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world:  "MAIN",
        func:   deleteUserFromPage,
        args:   [invueUserId],
      });
    } catch (e) {
      throw new Error(`InVue delete injection failed: ${e?.message ?? e}`);
    }

    if (!result?.[0]?.result) {
      throw new Error("Delete returned unexpected result — check InVue manually.");
    }
    return { ok: true };
  },

  // ── Power BI store search ─────────────────────────────────────────────────

  // searchByStore({ storeNumber, openIfMissing?, waitMs? })
  //   -> { ok, rows: [{Lock Name, store, ...}], count, storeNumber, ms }
  async searchByStore(msg) {
    const storeNumber = String(msg?.storeNumber ?? "").trim();
    if (!storeNumber) throw new Error("storeNumber required");
    const t0 = Date.now();
    // Persist the home store so the daily-refresh alarm can read it from SW context.
    chrome.storage.local.set({ [STORE_KEY]: storeNumber }).catch(() => {});

    const state = await ensurePowerBiTab({ openIfMissing: msg?.openIfMissing !== false });
    if (!state) throw new Error("Could not open Power BI tab");
    const tab = state.tab;

    let reauthAttempts = 0;
    try {
      while (true) {
        const pipeline = await runSearchPipeline(tab.id, storeNumber, msg?.waitMs ?? 60_000);
        if (pipeline.ok) {
          return { ...pipeline, ms: Date.now() - t0, reauthAttempts };
        }
        if (pipeline.errorClass !== "AUTH" || reauthAttempts >= MAX_REAUTH_ATTEMPTS) {
          return {
            ok: false,
            error:        pipeline.error || "Power BI search failed",
            errorClass:   pipeline.errorClass || null,
            authStatus:   pipeline.authStatus || null,
            authExhausted: pipeline.errorClass === "AUTH",
            reauthAttempts,
            ms:           Date.now() - t0,
            storeNumber,
          };
        }
        reauthAttempts++;
        console.log(`[digitallocks] auth-shaped response; reloading Power BI tab (autonomous reauth ${reauthAttempts}/${MAX_REAUTH_ATTEMPTS})`);
        const reloaded = await reloadTabAndWait(tab.id, {
          settleMs: 4000,
          timeoutMs: 35_000,
          waitForReady: async (tabId) => {
            const t = await chrome.tabs.get(tabId).catch(() => null);
            return !!t?.url && t.url.includes("app.powerbi.com") && t.status === "complete";
          },
        });
        if (!reloaded.ok) {
          return {
            ok: false,
            error:         `Power BI auth refresh failed: ${reloaded.reason}`,
            errorClass:    "AUTH",
            authExhausted: true,
            reauthAttempts,
            ms:            Date.now() - t0,
            storeNumber,
          };
        }
      }
    } finally {
      await closeIfOpened(state);
    }
  },

  // ── GScope UPC order cross-check ──────────────────────────────────────────

  // lookupUpcOrders({ upcs: string[], storeNumber: string, waitMs?: number })
  //   -> { ok, results: [{ upc, found, orderCount, lineStatuses }] }
  //
  // Requires gscope_capture.js to have intercepted at least one OMS request
  // (user must have GScope order resolution open and have run a search).
  async lookupUpcOrders(msg) {
    const upcs = Array.isArray(msg?.upcs) ? msg.upcs.filter(Boolean) : [];
    const storeNumber = String(msg?.storeNumber ?? "").trim();
    if (!upcs.length) throw new Error("upcs array required");
    if (!storeNumber) throw new Error("storeNumber required");

    const gscopeTab = await findGScopeTab();
    if (!gscopeTab) {
      return {
        ok: false,
        errorClass: "NO_TAB",
        error: "GScope order resolution is not open. Open GScope, run any search, then retry.",
      };
    }

    const cap = await waitForGScopeCapture(gscopeTab.id, msg?.waitMs ?? 20_000);
    if (!cap) {
      return {
        ok: false,
        errorClass: "NO_CAPTURE",
        error: "GScope has not captured auth headers yet. Run a search on the order resolution page, then retry.",
      };
    }

    const results = [];
    for (const upc of upcs) {
      try {
        const r = await fetchOrdersByWupc(upc, storeNumber, cap.headers);
        results.push({ upc, ...r });
      } catch (e) {
        results.push({ upc, found: false, error: e?.message ?? String(e) });
      }
    }
    return { ok: true, results };
  },

  // ── Associate hire date / tenure ──────────────────────────────────────────

  // lookupAssociate({ userId: string, refresh?: boolean })
  //   -> { ok, name?, title?, tenureDays?, lengthOfSvc?, fromCache? }
  //
  // Reads shared/associateDirectory.js, which is PERMANENT: a WIN we have
  // resolved before never hits Workday again. Tenure is recomputed from the
  // stored hire date on every call, so a cached record does not go stale.
  // Pass refresh:true to force a re-scrape (transfer, promotion, name change)
  // — there is no TTL that would catch those, and inventing one would mean
  // re-pulling everybody on the off chance.
  async lookupAssociate(msg) {
    const userId = String(msg?.userId ?? "").trim();
    if (!userId) throw new Error("userId required");

    if (msg?.refresh) await Directory.forget(userId);

    // Permanent hit — no network, no tab, regardless of how old it is.
    const known = await Directory.get(userId);
    if (known && known.hireDateApprox) {
      return {
        ok: true,
        name:        known.name ?? null,
        title:       known.title ?? null,
        tenureDays:  Directory.tenureDaysFor(known),
        lengthOfSvc: Directory.tenureLabelFor(known),
        fromCache:   true,
      };
    }

    // A lookup that just failed backs off briefly rather than re-driving the
    // tab on the next render.
    if (!msg?.refresh && await Directory.isRecentMiss(userId)) {
      return { ok: false, error: "Associate not found in directory (recent miss)" };
    }

    // Hard gate before any tab is opened or navigated. If the Workday host
    // permission is ever removed from manifest.json, executeScript throws on
    // every poll — the lookup would navigate a tab, spend 12s failing, cache
    // nothing, and be asked again on the next render. Checking first means a
    // missing permission costs zero navigations instead of one per associate.
    const allowed = await chrome.permissions
      .contains({ origins: [`${WORKDAY_ORIGIN}/*`] })
      .catch(() => false);
    if (!allowed) {
      return {
        ok: false,
        error: `No host permission for ${WORKDAY_ORIGIN} — Workday tenure lookup is disabled. ` +
               `Add it to manifest.json host_permissions to enable.`,
      };
    }

    // Serialise tab navigation: one lookup at a time, one tab we own.
    return enqueueAssocLookup(async () => {
      // Re-check inside the queue: a burst of lookups for the same WIN would
      // otherwise each pass the check above before the first one writes.
      const now = await Directory.get(userId);
      if (now?.hireDateApprox) {
        return {
          ok: true,
          name:        now.name ?? null,
          title:       now.title ?? null,
          tenureDays:  Directory.tenureDaysFor(now),
          lengthOfSvc: Directory.tenureLabelFor(now),
          fromCache:   true,
        };
      }

      // Delegated to shared/associateLookup.js, which owns the Workday tab
      // and the scrape now that every module needs job titles. It handles the
      // permission gate, the miss-marking and the Directory.merge() itself.
      const record = await lookupTitle(userId);
      if (!record || (!record.name && !record.title)) {
        return { ok: false, error: "Associate not found in directory" };
      }

      // lookupTitle already performed the Directory.merge(), so `record` is
      // the stored row. Tenure is recomputed from the stored hire date rather
      // than echoing the scraper's point-in-time figure, which would be wrong
      // the moment it was read back on another day.
      return {
        ok: true,
        name:        record?.name ?? null,
        title:       record?.title ?? null,
        tenureDays:  Directory.tenureDaysFor(record),
        lengthOfSvc: Directory.tenureLabelFor(record),
        fromCache:   false,
      };
    });
  },

  // ── Auror event creation for internal-theft cases ─────────────────────────
  //
  // createAurorEvent({ store, eventTime, lockName, zoneName, position,
  //                    associateName, associateId, tenureDays, notes })
  //   -> { status: "filled" | "error", url, log }
  //
  // Opens app.us.auror.co/event/new in a focused tab and fills:
  //   event type (Employee/Internal Theft), location, date, time, description.
  // Stops before Person details — operator completes and submits.
  async createAurorEvent(msg) {
    const {
      store, eventTime, lockName, zoneName, position,
      associateName, associateId, tenureDays, notes,
    } = msg ?? {};

    const tab = await chrome.tabs.create({ url: "https://app.us.auror.co/event/new", active: true });
    if (tab.windowId != null) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    }
    await waitForTabLoad(tab.id, 30_000);
    await sleep(1200);

    const d = new Date(eventTime || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    let hour = d.getHours() % 12;
    if (hour === 0) hour = 12;
    const timeStr = `${hour}:${pad(d.getMinutes())} ${d.getHours() >= 12 ? "PM" : "AM"}`;

    const hireDate = tenureDays != null
      ? new Date(Date.now() - tenureDays * 86_400_000).toLocaleDateString()
      : null;

    const description = [
      `On ${dateStr} at approximately ${timeStr},`,
      associateName ? `${associateName} (Walmart ID: ${associateId || "—"})` : `an associate (ID: ${associateId || "—"})`,
      hireDate ? `(approx. hire date: ${hireDate})` : null,
      position ? `, ${position},` : null,
      `was observed opening case ${lockName || "—"} in zone ${zoneName || "—"} at store ${store || "—"}.`,
      notes ? `Reviewer notes: ${notes}` : null,
      "This event was flagged by the Digital Locks automated review system.",
    ].filter(Boolean).join(" ");

    const nameParts = (associateName || "").trim().split(/\s+/);
    const associateLastName  = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
    const associateFirstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(" ") : nameParts[0] || "";

    let result;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: driveShopliftingForm,
        args: [{ store: String(store || ""), dateStr, timeStr, description, associateFirstName, associateLastName }],
        world: "MAIN",
      });
      result = injection?.result;
    } catch (e) {
      return { status: "error", error: `scripting.executeScript failed: ${e?.message ?? e}` };
    }

    if (!result) return { status: "error", error: "Form driver returned no result" };
    if (Array.isArray(result.log)) result.log.forEach((line) => console.log("[digitallocks/auror]", line));
    return { status: result.error ? "error" : "filled", url: result.url, log: result.log };
  },
};

// ── Power BI internals ────────────────────────────────────────────────────────

async function runSearchPipeline(tabId, storeNumber, waitMs) {
  const cap = await waitForCapture(tabId, waitMs);
  if (!cap) {
    return {
      ok: false, errorClass: "NO_CAPTURE",
      error: "No Power BI data-grid query captured. Open the report in Power BI and let the data grid render once, then retry.",
    };
  }

  const body = JSON.parse(cap.reqBody);
  const where = body?.queries?.[0]?.Query?.Commands?.[0]?.SemanticQueryDataShapeCommand?.Query?.Where;
  if (!Array.isArray(where) || !where.length) {
    return { ok: false, errorClass: "SHAPE", error: "Captured query has no Where clause — cannot apply store filter" };
  }
  const cond = where[0]?.Condition?.In;
  if (!cond?.Values?.[0]?.[0]?.Literal) {
    return { ok: false, errorClass: "SHAPE", error: "Captured query Where clause shape is unexpected — cannot patch store filter" };
  }
  cond.Values[0][0].Literal.Value = `'${storeNumber}'`;

  const headers = {
    "Authorization": cap.reqHeaders?.["Authorization"],
    "Content-Type": "application/json;charset=UTF-8",
    "X-PowerBI-HostEnv": cap.reqHeaders?.["X-PowerBI-HostEnv"] || "Power BI Web App",
    "Accept": "application/json, text/plain, */*",
  };
  let resp;
  try {
    resp = await fetch(cap.url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, errorClass: "NETWORK", error: `Replay fetch failed: ${e?.message || e}.` };
  }
  const respContentType = resp.headers.get("content-type") || "";
  const respText = await resp.text();
  const authStatus = classifyAuthResponse({ status: resp.status, contentType: respContentType, body: respText });
  if (isAuthFailureStatus(authStatus)) {
    return { ok: false, errorClass: "AUTH", authStatus, error: `Power BI replay returned ${authStatus} — autonomous reauth will retry.` };
  }
  if (!resp.ok) {
    return { ok: false, errorClass: "HTTP", error: `Replay HTTP ${resp.status}: ${respText.slice(0, 300)}` };
  }
  let parsed;
  try { parsed = JSON.parse(respText); }
  catch { return { ok: false, errorClass: "PARSE", error: "Replay response was not JSON." }; }
  const data = parsed?.results?.[0]?.result?.data;
  if (!data) {
    return { ok: false, errorClass: "SHAPE", error: "Replay response missing results[0].result.data" };
  }
  const rows = decodeDsr(data);
  return { ok: true, rows, count: rows.length, storeNumber, capturedAt: cap.capturedAt };
}

// Returns { tab, opened } — or null when nothing is open and we were told not
// to open one. `opened` decides cleanup: a Power BI tab the user was already
// working in must survive the search; one we opened must not outlive it,
// because the daily alarm runs this unattended and would otherwise leave a new
// background tab behind every single day.
async function ensurePowerBiTab({ openIfMissing }) {
  const existing = await chrome.tabs.query({ url: REPORT_TAB_FILTER });
  if (existing?.length) return { tab: existing[0], opened: false };
  if (!openIfMissing) return null;
  return { tab: await chrome.tabs.create({ url: POWER_BI_URL, active: false }), opened: true };
}

async function waitForCapture(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const cap = window.__APAISUITE_DIGITALLOCKS_CAP;
          if (!cap) return { installed: false };
          const q = cap.findDataGridQuery();
          return { installed: true, capture: q };
        },
      });
      const got = result?.[0]?.result;
      if (got?.capture) return got.capture;
    } catch {}
    await sleep(800);
  }
  return null;
}

// ── GScope internals ──────────────────────────────────────────────────────────

async function findGScopeTab() {
  const tabs = await chrome.tabs.query({ url: "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution*" });
  return tabs?.[0] ?? null;
}

async function waitForGScopeCapture(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const cap = window.__APAISUITE_DIGITALLOCKS_GSCOPE_CAP;
          if (!cap) return null;
          return cap.getCapture();
        },
      });
      const cap = result?.[0]?.result;
      if (cap?.headers) return cap;
    } catch {}
    await sleep(500);
  }
  return null;
}

async function fetchOrdersByWupc(wupc, storeId, headers) {
  const url = `${OMS_BASE}?limit=50&offset=0&storeId=${encodeURIComponent(storeId)}&wupc=${encodeURIComponent(wupc)}`;
  let resp;
  try {
    resp = await fetch(url, { method: "GET", headers });
  } catch (e) {
    return { found: false, error: `Network error: ${e?.message}` };
  }
  if (!resp.ok) return { found: false, error: `HTTP ${resp.status}` };
  let parsed;
  try { parsed = await resp.json(); } catch { return { found: false, error: "Non-JSON response" }; }

  if (parsed.status === "NOT_FOUND" || !parsed.payload?.length) {
    return { found: false, orderCount: 0, lineStatuses: [] };
  }

  const orders = parsed.payload;
  // Strip PII before returning — we only surface status/count/timing.
  const lineStatuses = [...new Set(orders.map((o) => o.lineStatus).filter(Boolean))];
  return {
    found: true,
    orderCount: parsed.header?.headerAttributes?.totalCount ?? orders.length,
    lineStatuses,
    mostRecentOrderDate: Math.max(...orders.map((o) => Number(o.orderDate) || 0)),
  };
}

// ── One Wire directory internals ──────────────────────────────────────────────

// Serial gate for associate lookups — each scrape navigates the shared tab,
// so concurrent calls would race to create duplicate tabs and clobber each other.
let _assocQueue = Promise.resolve();

function enqueueAssocLookup(fn) {
  const next = _assocQueue.then(fn, fn);
  _assocQueue = next.then(() => {}, () => {});
  return next;
}

async function waitForTabLoad(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await sleep(200);
  }
  return false;
}

// ── Auror Shoplifting form driver (injected via MAIN world) ──────────────────
//
// Mirrors the license-intake branch of aurorbuddy/lib/auror_event.js::driveForm.
// Event type is always "Shoplifting". Person 1 is filled directly from
// associateFirstName / associateLastName (no Auror P-number lookup needed).
//
// IMPORTANT: serialised by chrome.scripting.executeScript — no closure over
// outer variables. Every helper must be declared inline.

function driveShopliftingForm(data) {
  // data: { store, dateStr, timeStr, description, associateFirstName, associateLastName }
  const log = [];
  const note = (m) => log.push(m);

  const TIMEOUT_MS             = 15_000;
  const SETTLE_SHORT_MS        = 600;
  const SETTLE_AFTER_LOC_MS   = 2500;
  const SETTLE_NAV_MS          = 1500;
  const LOCATION_TIMEOUT       = 10_000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // React-aware value setter. Must run before focus so React controlled
  // components see the change through their synthetic event system.
  function setReactValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc  = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Character-by-character typing — required for React debounced autocomplete
  // inputs (location search). Each char fires the full keydown→InputEvent→keyup
  // sequence browsers produce, which React's synthetic event system requires.
  async function typeSlowly(el, text, { delayMs = 40 } = {}) {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const desc  = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, ""); else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    let current = "";
    for (const char of text) {
      current += char;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      if (desc?.set) desc.set.call(el, current); else el.value = current;
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: char, bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await sleep(delayMs);
    }
  }

  async function waitFor(selector, timeout = TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) return el;
      await sleep(100);
    }
    throw new Error(`timed out: ${selector}`);
  }

  async function safeFill(selector, value, timeout) {
    const el = await waitFor(selector, timeout);
    el.focus();
    setReactValue(el, value);
  }

  async function findByText(selector, text, timeout = TIMEOUT_MS) {
    const needle = text.toLowerCase();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const el of document.querySelectorAll(selector)) {
        if ((el.textContent || "").toLowerCase().includes(needle) && el.offsetParent !== null) return el;
      }
      await sleep(100);
    }
    throw new Error(`no ${selector} with text "${text}"`);
  }

  // Stable data-locator approach (same as aurorbuddy) for People/Vehicles radios.
  async function clickCountLabel(section, n) {
    const locator = `EventDetails-${section}-${n}`;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const el = document.querySelector(`[data-locator="${locator}"]`);
      if (el && el.offsetParent !== null) { el.click(); return; }
      await sleep(150);
    }
    throw new Error(`[data-locator="${locator}"] not found`);
  }

  // Fallback for People=1 when data-locator isn't present.
  async function clickPeopleOneFallback() {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const el of document.querySelectorAll("label, button, [role='button'], [role='radio']")) {
        if (el.offsetParent === null || (el.textContent || "").trim() !== "1") continue;
        let node = el.parentElement;
        for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
          if (/\bpeople\b|\bperson\b/i.test(node.textContent || "") && (node.textContent || "").length < 200) {
            el.click();
            return;
          }
        }
      }
      await sleep(150);
    }
    throw new Error("People=1 control not found");
  }

  // Expand the Person 1 section if Auror collapses it by default in the
  // Shoplifting flow. Waits for "Enter names here" to appear after expanding.
  async function expandPerson1IfCollapsed() {
    const already = document.querySelector("input[placeholder='Enter names here']");
    if (already && already.offsetParent !== null) { note("  Person 1 already expanded"); return; }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      for (const el of document.querySelectorAll("button, summary, h2, h3, h4, [role='button'], [data-locator]")) {
        if (el.offsetParent === null) continue;
        const t = (el.textContent || "").trim();
        if (/^Person\s*1(\s|$)/i.test(t) && t.length < 50) {
          el.click();
          note(`  Expanded "${t}"`);
          await sleep(600);
          const opened = document.querySelector("input[placeholder='Enter names here']");
          if (opened && opened.offsetParent !== null) return;
        }
      }
      await sleep(200);
    }
    note("  No Person 1 header to expand — assuming auto-expanded");
  }

  // Fill an input matched by placeholder text. Uses setReactValue (not typeSlowly)
  // since Person 1 name fields are not debounced autocomplete components.
  async function fillByPlaceholder(placeholders, value, label) {
    if (!value) return;
    const lows = placeholders.map((p) => p.toLowerCase());
    let el = null;
    for (const inp of document.querySelectorAll("input, textarea")) {
      if (inp.offsetParent === null) continue;
      const ph = (inp.placeholder || "").toLowerCase();
      if (!ph) continue;
      if (lows.some((c) => ph === c || ph.includes(c))) { el = inp; break; }
    }
    if (!el) { note(`! ${label}: no input with placeholder ${placeholders.join("/")}`); return; }
    el.focus();
    setReactValue(el, value);
    note(`${label} → filled`);
  }

  // Location option picker — same multi-selector approach as aurorbuddy.
  async function waitForLocationOption(storeNumber, timeoutMs) {
    const num = String(storeNumber).trim();
    if (!num) return null;
    const deadline = Date.now() + timeoutMs;
    const selectors = [
      "[role='option']", "[role='listbox'] li", "[role='menu'] li", "[role='listitem']",
      "ul[class*='option'] li", "ul[class*='dropdown'] li",
      "div[class*='option']", "div[class*='suggestion']", "li",
    ];
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent === null) continue;
          const t = (el.textContent || "").trim();
          if (!t || t.length > 200) continue;
          if (!new RegExp(`\\b${num}\\b`).test(t)) continue;
          const tl = t.toLowerCase();
          if (tl.includes("walmart") || tl.includes("store") || t.includes(",")) return el;
        }
      }
      await sleep(150);
    }
    return null;
  }

  // Witness-section 'Use my details' checkbox — same logic as aurorbuddy.
  async function clickWitnessUseMyDetails() {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const cb of document.querySelectorAll("input[type='checkbox']")) {
        if (cb.offsetParent === null) continue;
        let labelText = "";
        const wrapping = cb.closest("label");
        if (wrapping) labelText = (wrapping.textContent || "").trim();
        if (!labelText && cb.id) {
          const ext = document.querySelector(`label[for="${cb.id}"]`);
          if (ext) labelText = (ext.textContent || "").trim();
        }
        if (/^\s*use my details\s*$/i.test(labelText)) {
          if (cb.checked) return;
          cb.click();
          return;
        }
      }
      await sleep(150);
    }
    throw new Error("witness 'Use my details' checkbox not found");
  }

  return (async () => {
    try {
      // Prevent background timer throttling — same workaround as aurorbuddy.
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      Object.defineProperty(document, "hidden",          { get: () => false,     configurable: true });
      document.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);

      // ── Step 1: Event type → Shoplifting ─────────────────────────────────
      note("Event type → Shoplifting");
      let typeClicked = false;
      for (const label of ["Shoplifting", "Shop Lifting", "Shop-lifting", "Theft"]) {
        try {
          const btn = await findByText("button", label, 3000);
          if (btn) { btn.click(); note(`  clicked "${label}"`); typeClicked = true; break; }
        } catch { /* try next */ }
      }
      if (!typeClicked) note("! No Shoplifting button found");
      await sleep(SETTLE_SHORT_MS);

      // ── Step 2: Location ──────────────────────────────────────────────────
      if (data.store) {
        note(`Location → Walmart ${data.store}`);
        try {
          // typeSlowly is critical here: Auror's location search is a debounced
          // autocomplete that ignores bulk setReactValue calls.
          const locInput = await waitFor("input[placeholder='Search locations']", 6000);
          await typeSlowly(locInput, `Walmart ${data.store}`);
          await sleep(SETTLE_SHORT_MS);
          const opt = await waitForLocationOption(data.store, LOCATION_TIMEOUT);
          if (opt) {
            opt.click();
            note(`  selected: "${(opt.textContent || "").trim().slice(0, 60)}"`);
          } else {
            note(`! No location option matching store ${data.store}`);
          }
          await sleep(SETTLE_AFTER_LOC_MS);
        } catch (e) { note(`! Location: ${e.message}`); }
      }

      // ── Step 3: Date ──────────────────────────────────────────────────────
      if (data.dateStr) {
        note(`Date → ${data.dateStr}`);
        try {
          await safeFill("input[placeholder='MM/DD/YYYY']", data.dateStr);
          const dateEl = document.querySelector("input[placeholder='MM/DD/YYYY']");
          if (dateEl) {
            dateEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
            dateEl.blur();
          }
          await sleep(300);
        } catch (e) { note(`! Date: ${e.message}`); }
      }

      // ── Step 4: Time ──────────────────────────────────────────────────────
      if (data.timeStr) {
        note(`Time → ${data.timeStr}`);
        try {
          let timeEl = null;
          for (const sel of ["input[placeholder*='1:15 PM']", "input[placeholder*='AM']", "input[placeholder*='PM']",
                              "input[placeholder*='HH']", "input[placeholder*='hh']"]) {
            timeEl = document.querySelector(sel);
            if (timeEl && timeEl.offsetParent !== null) break;
            timeEl = null;
          }
          if (timeEl) {
            timeEl.focus();
            setReactValue(timeEl, data.timeStr);
            await sleep(200);
            timeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
            timeEl.dispatchEvent(new KeyboardEvent("keyup",   { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
            timeEl.blur();
            await sleep(300);
          } else note("! Time field not found");
        } catch (e) { note(`! Time: ${e.message}`); }
      }

      // ── Step 5: People = 1 (data-locator, then fallback) ─────────────────
      note("People = 1");
      let peopleClicked = false;
      try { await clickCountLabel("People", 1); peopleClicked = true; }
      catch (e) { note(`! People data-locator: ${e.message}`); }
      if (!peopleClicked) {
        try { await clickPeopleOneFallback(); peopleClicked = true; }
        catch (e) { note(`! People fallback: ${e.message}`); }
      }
      await sleep(1500);

      // ── Step 5b: Expand Person 1 panel ───────────────────────────────────
      try { await expandPerson1IfCollapsed(); }
      catch (e) { note(`! Person 1 expand: ${e.message}`); }
      await sleep(800);

      // ── Step 6: Fill Person 1 name fields directly ────────────────────────
      // Like the license-intake path: fill "Enter names here" and "Enter last
      // name here" directly with setReactValue (no person-lookup search step).
      note("Person 1 → name fields");
      await fillByPlaceholder(["Enter names here", "Enter names"], data.associateFirstName || "", "First names");
      await fillByPlaceholder(["Enter last name here", "Enter last name"], data.associateLastName || "", "Last name");
      await sleep(400);

      // ── Step 6b: Mark as member of staff ─────────────────────────────────
      // All digitallocks events involve Walmart associates, so we always click
      // "This person is a member of staff" in the Person 1 panel. Auror renders
      // this as a chip/radio label — try multiple selectors.
      note("Person 1 → This person is a member of staff");
      try {
        let staffEl = null;
        for (const [sel, needle] of [
          ["label",           "member of staff"],
          ["button",          "member of staff"],
          ["[role='button']", "member of staff"],
          ["label",           "staff"],
          ["button",          "staff"],
        ]) {
          staffEl = await findByText(sel, needle, 2000).catch(() => null);
          if (staffEl) {
            staffEl.click();
            note(`  clicked "${(staffEl.textContent || "").trim().slice(0, 60)}"`);
            await sleep(400);
            break;
          }
        }
        if (!staffEl) note("! 'Member of staff' option not found — operator must select");
      } catch (e) { note(`! Member of staff: ${e.message}`); }

      // ── Step 7: Products checkbox ─────────────────────────────────────────
      note("Products involved → check");
      try { (await findByText("label", "Products involved", 5000)).click(); }
      catch (e) { note(`! Products: ${e.message}`); }

      // ── Step 8: Next → Additional information ────────────────────────────
      note("Next → Additional information");
      (await findByText("button", "Next")).click();
      await sleep(SETTLE_NAV_MS);

      // ── Step 9: Description ───────────────────────────────────────────────
      if (data.description) {
        note("Description → fill");
        try {
          const expand = await findByText("button", "Additional information", 2000).catch(() => null);
          if (expand) { expand.click(); await sleep(SETTLE_SHORT_MS); }
          const textEl = await waitFor("textarea[placeholder*='Describe what happened']", 6000);
          textEl.focus();
          setReactValue(textEl, data.description);
        } catch (e) { note(`! Description: ${e.message}`); }
      }

      // ── Step 10: Next → Reporting details ────────────────────────────────
      note("Next → Reporting details");
      (await findByText("button", "Next")).click();
      await sleep(SETTLE_NAV_MS);

      // ── Step 11: Police → No ─────────────────────────────────────────────
      note("Police → No");
      try { (await findByText("label", "No", 5000)).click(); }
      catch (e) { note(`! Police No: ${e.message}`); }

      // ── Step 12: Reporter → Use my details ───────────────────────────────
      note("Reporter → Use my details");
      try { (await findByText("button", "Use my details", 5000)).click(); }
      catch (e) { note(`! Use my details: ${e.message}`); }

      // ── Step 13: Witnessed → Observed video footage ──────────────────────
      note("Witnessed → Observed video footage");
      try { (await findByText("label", "Observed video footage", 5000)).click(); }
      catch (e) { note(`! Witnessed: ${e.message}`); }

      // ── Step 14: Witness → Use my details checkbox ───────────────────────
      try { await clickWitnessUseMyDetails(); note("Witness → Use my details"); }
      catch (e) { note(`! Witness Use my details: ${e.message}`); }

      // ── Step 15: Done ─────────────────────────────────────────────────────
      note("Done");
      try {
        (await findByText("button", "Done", 5000)).click();
        await sleep(SETTLE_NAV_MS);
      } catch (e) { note(`! Done: ${e.message}`); }

      return { url: location.href, log };
    } catch (err) {
      return { error: String(err?.message ?? err), url: location.href, log };
    }
  })();
}

// Tab id of the background Workday tab this module opened, kept in
// storage.session so it survives the service worker going idle.
// WORKDAY_TAB_KEY / ensureWorkdayTab / scrapeDirectoryForUser moved to
// shared/associateLookup.js on 2026-08-22 — every module needs job titles,
// not just this one. The handler below now delegates.

/**
 * Get (or open) the module's OWN background Workday tab.
 *
 * This used to `chrome.tabs.query({ url: "https://wd504.myworkday.com/*" })`
 * and adopt whatever it found — which meant the user's own Workday tab. Every
 * lookup then `chrome.tabs.update()`d that tab to a directory search, so a
 * queue of associates walked the user's live Workday session from one WIN to
 * the next while they were using it. Never adopt a tab we did not open.
 */

