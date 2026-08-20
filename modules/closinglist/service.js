// modules/closinglist/service.js
//
// Service-worker handlers for the ClosingList module.
// Registered with the suite's SW dispatcher in background/service_worker.js
// via the module manifest's `service.handlers` lazy import.
//
// Adapted from ClosingList donor (extension/background.js). Changes:
//   - Storage keys namespaced ("closinglist.ivrFlowState", "closinglist.ivrLastResult")
//   - The cross-tab "ivr-absences-collected" inbound message is registered as
//     a proper handler that hands its payload off to whichever
//     collect-ivr-absences call is currently in-flight (single pending
//     resolver; UI button-disable prevents concurrent collects).
//   - Tab discovery uses chrome.tabs directly here (not shared/tabs.js) so
//     the service module stays runnable from the SW without extra imports.
//   - Full-automation mode: after resetIvrTab, if the IVR tab landed on an
//     SSO redirect, host.auth.clickSso auto-clicks the company SSO button
//     and waits for the redirect back to IVR before the absence-table
//     auto-progression begins.
//   - Daily auto-send: chrome.alarm fires at noon, collects CV + IVR,
//     builds the email via Parse, and POSTs to the Microsoft Graph sendMail
//     endpoint using the Bearer token passively captured from Outlook tabs.

import { createAuth, SSO_SELECTORS } from "../../shared/auth.js";
import { getUserHomeStore } from "../../shared/userStore.js";
import * as Parse from "./lib/parse.js";

const MODULE_ID       = "closinglist";
const IVR_ROOT_URL    = "https://ivrattcloud-prod.wal-mart.com/";
const IVR_HOST_RE     = /^https:\/\/ivrattcloud-prod\.wal-mart\.com\//;
const IVR_TAB_PATTERN = "https://ivrattcloud-prod.wal-mart.com/*";
const FLOW_KEY        = "closinglist.ivrFlowState";
const RESULT_KEY      = "closinglist.ivrLastResult";
const FLOW_TIMEOUT_MS = 180 * 1000;   // 3 min — accommodates MAC-error retries in ivr.js
const SSO_REDIRECT_TIMEOUT_MS = 45 * 1000;

const CV_ROOT_URL     = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";
const CV_HOST_RE      = /^https:\/\/radapps3\.wal-mart\.com\/Protected\/CaseVisibility\//;
const CV_TAB_PATTERN  = "https://radapps3.wal-mart.com/Protected/CaseVisibility/*";

// Auto-send alarm
const AUTO_ALARM_NAME    = "closinglist.dailySend";
const GRAPH_TOKEN_KEY    = "closinglist.graphToken";    // chrome.storage.session
const AUTO_STATUS_KEY    = "closinglist.autoSendLastStatus"; // chrome.storage.local
const PFX                = "closinglist.";
const GRAPH_TOKEN_TTL_MS = 55 * 60 * 1000; // 55 min — Graph tokens live ~60 min

const OUTLOOK_TAB_PATTERN = "https://outlook.office.com/*";
const OUTLOOK_URL         = "https://outlook.office.com/mail/";
const GRAPH_SEND_URL      = "https://graph.microsoft.com/v1.0/me/sendMail";
const EXCLUDE_JOBS_DEFAULT =
  "Stocking 2, Digital, AP Service, Auto Care, Cake Decorator, Deli/Bakery, " +
  "Dual Licensed Opt, Front End, In Home Delivery, Optician, Rx";

const auth = createAuth(MODULE_ID);

// Single in-flight collector resolver. The UI's Collect button disables
// during collection, so concurrent calls aren't expected; if they occur the
// second simply replaces the first (the first will time out naturally).
let pendingIvrResolver = null;

// ── Shared helpers ──────────────────────────────────────────────────────────

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function waitForTabLoad(tabId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

// ── IVR helpers ─────────────────────────────────────────────────────────────

async function findOrOpenIvrTab() {
  const existing = await chrome.tabs.query({ url: IVR_TAB_PATTERN });
  if (existing.length > 0) return existing[0];
  return chrome.tabs.create({ url: IVR_ROOT_URL, active: false });
}

async function resetIvrTab(tabId) {
  // Navigate to root so the content script starts from a known state.
  await chrome.tabs.update(tabId, { url: IVR_ROOT_URL, active: false });
}

// If the IVR tab landed on an SSO redirect after resetIvrTab, auto-click
// the company SSO button and poll for the redirect back to IVR. Without
// this the IVR content script never fires (it's only injected on the IVR
// origin) and collectIvrAbsences times out.
async function ensureIvrAuth(tabId) {
  const initial = await waitForTabLoad(tabId, 30_000);
  if (!initial) return; // tab gone — caller's collection promise will time out

  if (IVR_HOST_RE.test(initial.url || "")) return; // already on IVR

  // Off IVR — try SSO auto-click, then poll for redirect back.
  await auth.clickSso(tabId, SSO_SELECTORS);

  const deadline = Date.now() + SSO_REDIRECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    if (IVR_HOST_RE.test(t.url || "")) {
      await chrome.tabs.update(tabId, { url: IVR_ROOT_URL, active: false });
      await waitForTabLoad(tabId, 15_000);
      return;
    }
  }
}

async function collectIvrAbsences() {
  await chrome.storage.local.set({
    [FLOW_KEY]: { active: true, startedAt: Date.now() },
  });

  const resultPromise = new Promise((resolve) => {
    pendingIvrResolver = resolve;
    setTimeout(() => {
      if (pendingIvrResolver === resolve) {
        pendingIvrResolver = null;
        resolve({
          ok: false,
          error: `IVR collection timed out (${FLOW_TIMEOUT_MS / 1000}s). Make sure you are signed in to IVR ATT Cloud.`,
        });
      }
    }, FLOW_TIMEOUT_MS);
  });

  try {
    const tab = await findOrOpenIvrTab();
    await resetIvrTab(tab.id);
    await ensureIvrAuth(tab.id);
    const result = await resultPromise;
    await chrome.storage.local.set({
      [FLOW_KEY]:   { active: false },
      [RESULT_KEY]: { ...result, fetchedAt: new Date().toISOString() },
    });
    return result;
  } catch (e) {
    pendingIvrResolver = null;
    await chrome.storage.local.set({ [FLOW_KEY]: { active: false } });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── CaseVisibility collection from SW ───────────────────────────────────────

async function ensureCVAuth(tabId) {
  const initial = await waitForTabLoad(tabId, 30_000);
  if (!initial) return;
  if (CV_HOST_RE.test(initial.url || "")) return;

  await auth.clickSso(tabId, SSO_SELECTORS);

  const deadline = Date.now() + SSO_REDIRECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    if (CV_HOST_RE.test(t.url || "")) {
      await chrome.tabs.update(tabId, { url: CV_ROOT_URL, active: false });
      await waitForTabLoad(tabId, 15_000);
      return;
    }
  }
}

function tabSendMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

async function collectCVSchedule(storeNbr, businessDate) {
  const existing = await chrome.tabs.query({ url: CV_TAB_PATTERN });
  let tab = existing[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: CV_ROOT_URL, active: false });
  }
  // Always navigate to root so the content script starts from a known state.
  await chrome.tabs.update(tab.id, { url: CV_ROOT_URL, active: false });
  await ensureCVAuth(tab.id);
  await waitForTabLoad(tab.id, 15_000);

  const msg = { module: MODULE_ID, type: "collect-schedule", storeNbr: String(storeNbr), businessDate };

  const attempt = () => tabSendMessage(tab.id, msg);
  let resp;
  try {
    resp = await attempt();
  } catch (e) {
    if (/Receiving end does not exist/i.test(e?.message ?? "")) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["modules/closinglist/content/casevisibility.js"],
      });
      await new Promise((r) => setTimeout(r, 300));
      resp = await attempt();
    } else {
      throw e;
    }
  }

  if (!resp?.ok) throw new Error(resp?.error || "collect-schedule returned no data");
  return resp.data;
}

// ── Graph API token ──────────────────────────────────────────────────────────
//
// Two sources, tried in order:
//   1. webRequest capture: stored in chrome.storage.session by the suite-wide
//      webRequest dispatcher whenever Outlook calls graph.microsoft.com.
//   2. MSAL sessionStorage/localStorage: MSAL.js stores access tokens in the
//      page's storage under keys containing "accesstoken" and the Graph scope.
//      Reading these via executeScript({world:"MAIN"}) works even when Outlook
//      routes its network calls through substrate.office.com instead of
//      graph.microsoft.com (which bypasses our webRequest capture).

async function getGraphToken() {
  const s = await chrome.storage.session.get(GRAPH_TOKEN_KEY).catch(() => ({}));
  const saved = s?.[GRAPH_TOKEN_KEY];
  if (!saved?.value) return null;
  if (Date.now() - (saved.at || 0) > GRAPH_TOKEN_TTL_MS) return null;
  return saved.value; // includes "Bearer " prefix
}

// Extract the MSAL access token directly from the Outlook tab's page storage.
// MSAL.js (used by Outlook web) stores tokens in sessionStorage/localStorage
// under keys that include "accesstoken" and the resource scope. The value's
// `secret` field is the raw Bearer token; `expiresOn` is an ISO string.
async function extractMsalToken(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const stores = [];
      try { stores.push(sessionStorage); } catch (_) {}
      try { stores.push(localStorage); } catch (_) {}
      for (const store of stores) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key) continue;
          if (!key.toLowerCase().includes("accesstoken")) continue;
          if (!key.toLowerCase().includes("graph.microsoft.com")) continue;
          try {
            const v = JSON.parse(store.getItem(key) || "{}");
            const secret = v?.secret;
            if (!secret) continue;
            // expiresOn can be an ISO string (MSAL v2) or epoch seconds (v1).
            const exp = v?.expiresOn ?? v?.expirationTime;
            const expMs = typeof exp === "string" && exp.includes("T")
              ? new Date(exp).getTime()
              : typeof exp === "number" ? exp * 1000 : 0;
            // Require at least 2 minutes of life left.
            if (expMs && Date.now() > expMs - 120_000) continue;
            return "Bearer " + secret;
          } catch (_) {}
        }
      }
      return null;
    },
  }).catch(() => []);
  return results?.[0]?.result ?? null;
}

// Obtain a valid Graph token, trying every source before giving up.
async function getAnyGraphToken(tabId) {
  const webReq = await getGraphToken();
  if (webReq) return webReq;
  if (tabId) {
    const msal = await extractMsalToken(tabId).catch(() => null);
    if (msal) return msal;
  }
  return null;
}

// If no fresh token is in cache, open (or reuse) an Outlook tab in the
// background and extract the token via MSAL storage after it loads.
// Also polls the webRequest cache as a secondary path.
async function wakeOutlookForToken() {
  const existing = await chrome.tabs.query({ url: OUTLOOK_TAB_PATTERN });
  let tabId;
  let opened = false;

  if (existing.length > 0) {
    tabId = existing[0].id;
    // Try MSAL extraction on the already-open tab first — no reload needed.
    const direct = await extractMsalToken(tabId).catch(() => null);
    if (direct) return direct;
    await chrome.tabs.reload(tabId, { bypassCache: false });
  } else {
    const tab = await chrome.tabs.create({ url: OUTLOOK_URL, active: false });
    tabId = tab.id;
    opened = true;
  }

  await waitForTabLoad(tabId, 30_000);

  // Poll both sources until we get a token or time out.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_500));
    const token = await getAnyGraphToken(tabId);
    if (token) return token;
  }

  if (opened) chrome.tabs.remove(tabId).catch(() => {});
  return null;
}

async function sendMailViaGraph(token, { to, subject, body }) {
  const resp = await fetch(GRAPH_SEND_URL, {
    method: "POST",
    headers: {
      "Authorization": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Graph sendMail ${resp.status}: ${text.slice(0, 300)}`);
  }
}

// ── Daily auto-send execution ────────────────────────────────────────────────

async function writeAutoStatus(ok, message) {
  return chrome.storage.local.set({
    [AUTO_STATUS_KEY]: { ok, message, at: new Date().toISOString() },
  }).catch(() => {});
}

async function executeDailySend({ force = false } = {}) {
  // Read all persisted settings (raw chrome.storage.sync with "closinglist." prefix).
  const s = await chrome.storage.sync.get([
    `${PFX}autoSendEnabled`,
    `${PFX}autoSendRecipient`,
    `${PFX}storeNbr`,
    `${PFX}startHour`,
    `${PFX}endHour`,
    `${PFX}excludeOvernight`,
    `${PFX}excludeJobs`,
    `${PFX}includeIvr`,
    `${PFX}showJobTitles`,
  ]);

  // force=true is used by the manual "Send Now" button so it runs even when
  // auto-send is toggled off. The scheduled alarm always uses force=false.
  if (!force && !s[`${PFX}autoSendEnabled`]) return;

  const recipient     = s[`${PFX}autoSendRecipient`] || "1458leadership@walmart.onmicrosoft.com";
  const storeNbr      = (await getUserHomeStore()) || s[`${PFX}storeNbr`] || "1458";
  const startHour     = s[`${PFX}startHour`]          ?? 13;
  const endHour       = s[`${PFX}endHour`]            ?? 17;
  const excludeOvernight = s[`${PFX}excludeOvernight`] ?? true;
  const excludeJobs   = s[`${PFX}excludeJobs`]        ?? EXCLUDE_JOBS_DEFAULT;
  const includeIvr    = s[`${PFX}includeIvr`]         ?? true;
  const showJobTitles = s[`${PFX}showJobTitles`]      ?? false;
  const businessDate  = todayIso();

  try {
    // 1. Collect CaseVisibility schedule.
    const cvData = await collectCVSchedule(storeNbr, businessDate);

    // 2. Collect IVR (optional; non-fatal).
    let ivrRows = [];
    if (includeIvr) {
      try {
        const ivrResp = await collectIvrAbsences();
        ivrRows = ivrResp.rows || [];
      } catch (_) { /* proceed without IVR */ }
    }

    // 3. Build email body.
    const model = Parse.build(cvData, { cutoff: { startHour, endHour }, excludeOvernight, excludeJobs, ivrRows });
    const body  = Parse.render(model, { storeNbr, businessDate, showJobTitles });
    const subject = `Closing List — Store ${storeNbr} — ${businessDate}`;

    // 4. Get Graph token: try cache/MSAL first, then wake Outlook.
    let token = await getAnyGraphToken(null);
    if (!token) token = await wakeOutlookForToken();
    if (!token) throw new Error("No Outlook session found. Open Outlook and try again, or sign in manually.");

    // 5. Send via Microsoft Graph.
    await sendMailViaGraph(token, { to: recipient, subject, body });

    // 6. Persist success + show notification.
    const sentAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await writeAutoStatus(true, `Sent to ${recipient} at ${sentAt}.`);
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icons/suite-128.png"),
      title: "ClosingList Sent",
      message: `Store ${storeNbr} closing list sent to ${recipient}.`,
    });

    // Broadcast so the open view refreshes its status display.
    chrome.runtime.sendMessage({
      module: MODULE_ID, type: "auto-send-status-changed",
    }).catch(() => {});

  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 250);
    await writeAutoStatus(false, msg);
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icons/suite-128.png"),
      title: "ClosingList Auto-Send Failed",
      message: msg,
    });
    chrome.runtime.sendMessage({
      module: MODULE_ID, type: "auto-send-status-changed",
    }).catch(() => {});
  }
}

// ── Alarm management ─────────────────────────────────────────────────────────

function nextNoonMs() {
  const now  = new Date();
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  if (noon <= now) noon.setDate(noon.getDate() + 1);
  return noon.getTime();
}

export async function installDailySendAlarm() {
  const existing = await chrome.alarms.get(AUTO_ALARM_NAME);
  if (existing) return; // already scheduled — period is preserved on resume
  chrome.alarms.create(AUTO_ALARM_NAME, {
    when: nextNoonMs(),
    periodInMinutes: 1440, // daily
  });
}

export async function clearDailySendAlarm() {
  await chrome.alarms.clear(AUTO_ALARM_NAME);
}

// Registered at module.js top-level so Chrome wakes the SW on the alarm.
export function onAlarm(alarm) {
  if (alarm.name !== AUTO_ALARM_NAME) return;
  executeDailySend().catch((e) => {
    console.error("[closinglist] daily auto-send threw:", e);
  });
}

// ── Message handlers ─────────────────────────────────────────────────────────

export const handlers = {
  async "collect-ivr-absences"(_msg) {
    return collectIvrAbsences();
  },

  async "get-last-ivr-result"(_msg) {
    const r = await chrome.storage.local.get(RESULT_KEY);
    return r[RESULT_KEY] || null;
  },

  // Inbound from the IVR content script when it finishes scraping.
  async "ivr-absences-collected"(msg) {
    if (pendingIvrResolver) {
      pendingIvrResolver({
        ok:         !!msg.ok,
        rows:       msg.rows || [],
        capturedAt: msg.capturedAt,
        sourceUrl:  msg.sourceUrl,
        error:      msg.error || null,
      });
      pendingIvrResolver = null;
    }
    return { ok: true };
  },

  // Auto-send: get current status + enabled setting.
  async "auto-send-get-status"(_msg) {
    const [local, sync, alarm] = await Promise.all([
      chrome.storage.local.get(AUTO_STATUS_KEY),
      chrome.storage.sync.get([`${PFX}autoSendEnabled`, `${PFX}autoSendRecipient`]),
      chrome.alarms.get(AUTO_ALARM_NAME),
    ]);
    return {
      ok: true,
      enabled:          !!sync[`${PFX}autoSendEnabled`],
      recipient:        sync[`${PFX}autoSendRecipient`] || "1458leadership@walmart.onmicrosoft.com",
      lastStatus:       local[AUTO_STATUS_KEY] || null,
      nextScheduledAt:  alarm?.scheduledTime ?? null,
    };
  },

  // Auto-send: save settings (enabled + recipient) and install/clear alarm.
  async "auto-send-save-settings"(msg) {
    const enabled   = !!msg.enabled;
    const recipient = String(msg.recipient || "").trim() || "1458leadership@walmart.onmicrosoft.com";
    await chrome.storage.sync.set({
      [`${PFX}autoSendEnabled`]:   enabled,
      [`${PFX}autoSendRecipient`]: recipient,
    });
    if (enabled) {
      await installDailySendAlarm();
    } else {
      await clearDailySendAlarm();
    }
    return { ok: true, enabled, recipient };
  },

  // Auto-send: manual test trigger from the UI — bypasses the enabled guard.
  async "auto-send-trigger-now"(_msg) {
    executeDailySend({ force: true }).catch((e) => console.error("[closinglist] manual trigger threw:", e));
    return { ok: true };
  },
};
