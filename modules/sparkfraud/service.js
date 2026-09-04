// modules/sparkfraud/service.js
//
// Service-worker handlers for SparkFraud. Loaded statically by the SW
// dispatcher via module.js → registry.
//
// Adapted from donor extension/background.js. Key changes:
//   - chrome.runtime.onMessage switch → handlers object exported for the
//     suite SW dispatcher to route by (module, type)
//   - Storage keys session.authTabId / session.omsHeaders →
//     sparkfraud.authTabId / sparkfraud.omsHeaders (avoids the coexistence
//     trap when standalone SparkFraud is also installed)
//   - Capture buffer name window.__SPARK_CAP → window.__APAISUITE_SPARKFRAUD_CAP
//     (matches content/capture.js — also a coexistence safeguard)
//   - gscope SSO auto-click delegated to host.auth.clickSso
//   - gscope cookies read via host.auth.readCookiesViaTab (the Walmart-corp-
//     Edge workaround SparkFraud documented in its registries/auth_modes.json)

import { createAuth, reloadTabAndWait } from "../../shared/auth.js";
import { ensureAlarm, IS_SERVICE_WORKER } from "../../shared/alarms.js";
import { registerSessionTab, touchSessionTab } from "../../shared/tabSessions.js";
import { observeIdentity, parseWireId } from "../../shared/identity.js";
import {
  GSCOPE_HOST,
  isStuckGscopeUrl,
  isUsableGscopeUrl,
} from "./lib/gscope_urls.js";

const MODULE_ID = "sparkfraud";

const STORAGE_AUTH_TAB_KEY = "sparkfraud.authTabId";
const STORAGE_OMS_HEADERS_KEY = "sparkfraud.omsHeaders";
const STORAGE_IMG_PREFIX      = "sparkfraud.img:";
const STORAGE_WATCHLIST_KEY        = "sparkfraud.watchlist";
const STORAGE_WATCHLIST_STATE_KEY  = "sparkfraud.watchlist_state";
const STORAGE_WATCHLIST_HITS_KEY   = "sparkfraud.watchlist_hits";

const CAPTURE_GLOBAL_NAME = "__APAISUITE_SPARKFRAUD_CAP";

const ALARM_NAME = "sparkfraud.watchlist-poll";
const WATCHLIST_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const ENUMS_URL = chrome.runtime.getURL("modules/sparkfraud/registries/enums.json");
const SWIFT_DASHBOARD_URL = "https://swift.walmart.com/sparkApp/api/proxy/v4/dashboard";

const SSO_FORM_LOAD_TIMEOUT_MS = 5000;
// Direct SSO entry point via PingFederate IdP. The donor used
// https://gscope.walmartlabs.com/login + a "Sign in using Company SSO" button,
// which is one step longer than necessary — the SSO flow ultimately lands on
// pfedprod with a "Go" button anyway. Going to pfedprod directly skips the
// gscope /login hop.
const SSO_START_URL = "https://pfedprod.wal-mart.com/idp/startSSO.ping?PartnerSpId=https://gscope.walmartlabs.com/sp";
const SSO_REDIRECT_TIMEOUT_MS = 45_000;

const auth = createAuth(MODULE_ID);

// ── helpers ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForTabUrl(tabId, urlSubstr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.includes(urlSubstr) && tab.status === "complete") {
      return tab;
    }
    await sleep(500);
  }
  throw new Error("Tab did not navigate to " + urlSubstr + " in time");
}

async function injectAndRetry(tabId, fn, args, maxAttempts = 10, delayMs = 1500) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        args,
        func: fn,
      });
      const hit = results.find(r => r.result && r.result.ok);
      if (hit) return hit.result;
      lastResult = results;
      // Remember the most specific thing a frame said. "exhausted retries"
      // on its own told the user nothing — it covered both "the form never
      // appeared" and "the request fired but nothing captured it".
      const said = results.map(r => r?.result).find(r => r && !r.skipped && r.error);
      if (said) lastError = said.error;
      else if (results.every(r => r?.result?.skipped)) lastError = "no frame had the form";
    } catch (e) {
      lastResult = String(e);
      lastError = String(e);
    }
    await sleep(delayMs);
  }
  return { ok: false, error: `exhausted retries — ${lastError || "no result"}`, lastResult };
}

// Drive the gscope SSO chain to a usable state. Polls the tab and clicks
// the "Go" submit button on every page in the chain that exposes one. The
// Go button appears on (at least) two pages:
//
//   1. https://pfedprod.wal-mart.com/idp/...  — PingFederate IdP
//      "you are about to be signed in" form. With cached AAD/SSO creds
//      pfedprod usually auto-submits and you don't see this at all.
//
//   2. https://gscope.walmartlabs.com/api/wmstoresso — gscope's store-select
//      form. Hidden fields (authentication-src, wireId, storeno, office,
//      username, password) are pre-populated; a single <input type=submit
//      value=Go> POSTs to /api/proxy which sets the authtoken/authheader
//      cookies and redirects to /apphome.
//
// Earlier versions of this code only clicked on pfedprod and treated
// wmstoresso as "stuck — re-navigate". That looped forever because pfedprod
// silently bounces back to wmstoresso when creds are cached. This unified
// driver clicks Go on whichever page is currently loaded and exits when a
// non-stuck gscope URL is reached.
async function driveGscopeAuthChain(tabId, timeoutMs = SSO_REDIRECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastClickAt = 0;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { return false; }
    const url = tab.url || "";

    if (isUsableGscopeUrl(url) && tab.status === "complete") {
      return true;
    }

    const isPfedprod   = url.includes("pfedprod.wal-mart.com");
    const isWmstoresso = url.includes("/api/wmstoresso");

    // Rate-limit clicks to one per 1.5s — clicking again mid-form-submit
    // would risk a double POST.
    if ((isPfedprod || isWmstoresso) && Date.now() - lastClickAt > 1500) {
      const matched = await _clickGoViaCdp(tabId);
      if (matched) {
        console.log("[SparkFraud auth] clicked Go on",
                    isWmstoresso ? "wmstoresso" : "pfedprod", "—", matched);
        lastClickAt = Date.now();
      }
    }
    await sleep(500);
  }
  return false;
}

// Click the Go submit button via CDP Runtime.evaluate (not chrome.scripting).
// Why: Walmart-corp Edge MDM policy makes chrome.scripting.executeScript hang
// indefinitely on gscope.walmartlabs.com/api/wmstoresso for BOTH isolated and
// MAIN worlds (verified live via CDP probe — raw Runtime.evaluate works
// fine, but chrome.scripting times out). Same family of breakage as the
// gutted chrome.cookies.getAll({}) that necessitates readCookiesViaTab.
//
// The chrome.debugger attachment was made earlier by _spoofVisibility; we
// just piggyback the click on the same connection. Returns a short label
// describing what was clicked, or null if nothing matched.
async function _clickGoViaCdp(tabId) {
  if (!_spoofedTabs.has(tabId)) {
    // Debugger isn't attached — _spoofVisibility wasn't called (or failed).
    // Fall back to chrome.scripting; on tabs that aren't subject to the MDM
    // policy this still works.
    return await auth.clickSso(tabId, [
      { css: "input[type='submit'][value='Go' i]" },
      { text: /^go$/i },
      { text: /^continue$/i },
      { css: "button[type='submit']" },
      { css: "input[type='submit']" },
    ]);
  }
  try {
    const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: `
        (() => {
          function isVisible(el) { return el && el.offsetParent !== null; }
          const tries = [
            () => document.querySelector('input[type="submit"][value="Go" i]'),
            () => Array.from(document.querySelectorAll('button, a, [role="button"]'))
                    .find(el => /^go$/i.test((el.textContent || '').trim())),
            () => Array.from(document.querySelectorAll('button, a, [role="button"]'))
                    .find(el => /^continue$/i.test((el.textContent || '').trim())),
            () => document.querySelector('button[type="submit"]'),
            () => document.querySelector('input[type="submit"]'),
          ];
          for (const tryFn of tries) {
            const el = tryFn();
            if (isVisible(el)) { el.click(); return el.tagName + ':' + (el.value || el.textContent || '').trim().slice(0, 20); }
          }
          return null;
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });
    return r?.result?.value ?? null;
  } catch (e) {
    console.warn("[SparkFraud auth] CDP click failed:", e?.message ?? e);
    return null;
  }
}

// Tracks tabs where we've attached chrome.debugger for the visibility spoof.
// Avoids "another debugger is already attached" errors on overlapping calls.
const _spoofedTabs = new Set();

// Tabs _foregroundIfStillStuck has handed to the user for an interactive step
// (Okta MFA, consent, "stay signed in?"). ourAuthTab() must not re-drive one:
// navigating it back to pfedprod destroys the prompt the user is answering.
const _foregroundedTabs = new Set();

chrome.tabs.onRemoved.addListener(tabId => {
  _spoofedTabs.delete(tabId);
  _foregroundedTabs.delete(tabId);
});

// ── chrome.debugger is OPTIONAL, and absent in the store build ──────────────
//
// `debugger` is the most heavily scrutinised permission in this manifest and
// only this module wants it, so scripts/pack-cws.sh strips it from the staged
// manifest for the Chrome Web Store package. Everything below must therefore
// work when the API simply is not there.
//
// This listener was the one place that could not: it runs at MODULE LOAD, so
// an unguarded `chrome.debugger.onDetach` throws during service-worker
// registration and takes EVERY module down with it — the suite would not start
// at all, and nothing would point at SparkFraud as the cause.
//
// The other two call sites already degrade on their own — _clickGoViaCdp falls
// back to chrome.scripting when no tab is attached — but _spoofVisibility is
// given an explicit check below rather than relying on its try/catch swallowing
// a TypeError, because "the API is missing" and "attaching failed" deserve
// different log lines.
const HAS_DEBUGGER = typeof chrome !== "undefined" && !!chrome.debugger;

if (HAS_DEBUGGER) {
  chrome.debugger.onDetach.addListener(source => {
    if (source?.tabId != null) _spoofedTabs.delete(source.tabId);
  });
}

// Spoof document.visibilityState for the tab BEFORE its next navigation.
// Background tabs throttle JS heavily (timer clamps, deferred Promise
// microtasks); SSO chains that bounce through pfedprod → Okta → gscope
// often stall on intermediate-page JS. Injecting the spoof via CDP
// Page.addScriptToEvaluateOnNewDocument means every document loaded in
// the SSO chain runs with visibilityState = "visible" and the throttling
// never engages. Same pattern lib/evidence_downloader.js uses for CCTV.
async function _spoofVisibility(tabId) {
  if (!HAS_DEBUGGER) {
    // Store build. SSO still runs — it just loses the throttling workaround,
    // so a stalled chain ends in the tab being foregrounded for a manual
    // click instead of completing silently.
    console.info("[SparkFraud auth] no chrome.debugger in this build — background SSO may need a manual click");
    return false;
  }
  if (_spoofedTabs.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
      source: `
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
      `,
    });
    _spoofedTabs.add(tabId);
    return true;
  } catch (e) {
    // Most common cause: another extension or DevTools already attached.
    // Not fatal — SSO might still succeed if the user happens to be
    // viewing the tab, or if Walmart's SSO chain is pure HTTP redirects.
    console.warn("[SparkFraud auth] visibilityState spoof failed:", e?.message ?? e);
    return false;
  }
}

async function _unspoofVisibility(tabId) {
  if (!_spoofedTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  _spoofedTabs.delete(tabId);
}

// If the auth tab is stuck after the SSO chain timed out, foreground it so
// the user can complete whatever interactive step Walmart is asking for
// (Okta MFA, "stay signed in?", consent). Returns a friendly error code
// the UI maps to a meaningful status. The background-only rule applies to
// the optimistic path; once auto-SSO fails, interactive auth is the only
// way forward, and that requires the tab to be in foreground.
//
// CRITICAL UX: we POP the auth tab into its OWN new window rather than
// activating it in its current window. Otherwise activating the auth tab
// in a window that also holds the APAISuite extension tab pushes APAISuite
// out of view — the user sees the auth page take over what looks like
// "their extension tab". The new-window approach keeps the extension tab
// in its original window untouched.
async function _foregroundIfStillStuck(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return null;
    const url = tab.url || "";
    // If we somehow landed on usable gscope, no foreground needed.
    if (isUsableGscopeUrl(url)) {
      return null;
    }
    // Detach debugger so the user doesn't see the "automated test software"
    // banner during their manual sign-in.
    await _unspoofVisibility(tabId);
    _foregroundedTabs.add(tabId);

    // Try to move the auth tab into its own focused window. If the tab is
    // already the sole tab in its window, Chrome silently no-ops the move
    // — in that case fall back to simply focusing the existing window.
    let moved = false;
    try {
      const win = await chrome.windows.create({
        tabId,
        focused: true,
        type: "normal",
      });
      if (win?.id != null) moved = true;
    } catch (e) {
      console.warn("[SparkFraud auth] couldn't move auth tab to new window:", e?.message ?? e);
    }
    if (!moved) {
      // Fallback: activate in current window. May obscure the extension tab
      // if both share a window — but better than leaving the user with no
      // way to see the auth prompt.
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      if (tab.windowId != null) {
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
      }
    }

    return {
      ready: false,
      reason: "auth-needs-interaction",
      message: "Walmart's SSO is asking for sign-in (Okta MFA, consent, or session re-validation). The auth tab has been opened in its own window — finish the prompts there, then come back to APAISuite and retry your action.",
      tabId,
      stuckUrl: url,
      movedToNewWindow: moved,
    };
  } catch (_) {
    return null;
  }
}

// isStuckGscopeUrl / isUsableGscopeUrl / GSCOPE_HOST live in
// ./lib/gscope_urls.js — pure, and tested there. Read the header of that file
// before touching the readiness test: it is a HOSTNAME comparison on purpose.

// gscope's session cookies carry the two best identity signals in the suite:
// `store-no` is the store Walmart's own session is scoped to (the only source
// that is not a WIN suffix, i.e. the only one that is right after a transfer),
// and `wire-id` is "Display Name - loginId". Both were already being read here
// and thrown away after building a request header.
//
// Recorded for the whole suite so the home store stops depending on whether
// this particular analyst happens to use AurorBuddy. Fire-and-forget: identity
// is a convenience, and nothing about a Dispatcher search should fail because
// a storage write did.
function recordGscopeIdentity(ci) {
  try {
    const store = String(ci["store-no"] || ci.storeno || "").trim();
    const { displayName, win } = parseWireId(ci["wire-id"]);
    if (!store && !win && !displayName) return;
    observeIdentity({
      source: "gscope_session",
      store: /^\d{1,5}$/.test(store) ? String(parseInt(store, 10)) : "",
      win,
      displayName,
    }).catch(() => {});
  } catch { /* never let identity bookkeeping break a search */ }
}

// The real test of "is this session alive". isStuckGscopeUrl only judges the
// URL, and an expired session sits on a URL that looks completely fine.
function hasAuthCookies(cookies) {
  if (!cookies) return false;
  const lower = Object.keys(cookies).map(k => k.toLowerCase());
  return lower.includes("authtoken") && lower.includes("authheader");
}

// Read cookies from the first responsive tab. (Walmart-corp-Edge gutted
// chrome.cookies.getAll({}), so we read document.cookie via in-tab
// executeScript and merge with chrome.cookies.getAll({url}) for the HttpOnly
// ones.) Returns { cookies, usedTab } — cookies is null if every tab timed out.
async function readCookiesFromTabs(tabs, log = () => {}) {
  for (const tab of tabs) {
    try {
      log("trying tab", tab.id, tab.url);
      const merged = await Promise.race([
        auth.readCookiesViaTab(tab.id),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("readCookiesViaTab-5s-timeout")), 5000)
        ),
      ]);
      log("got cookies from tab", tab.id, "count:", Object.keys(merged).length);
      return { cookies: merged, usedTab: tab };
    } catch (e) {
      log("tab", tab.id, "failed:", String(e));
    }
  }
  return { cookies: null, usedTab: null };
}

// Every gscope tab that is on a real content page, with `preferTabId` FIRST.
//
// Ordering is load-bearing on the re-auth path. `chrome.tabs.query` returns
// window/index order, so the tab we just drove through the SSO chain lands
// wherever the user happens to have it — and `readCookiesFromTabs` reads the
// FIRST responsive tab. Reading the analyst's stale /apphome tab instead of
// the one we just authenticated is how a successful re-auth reported
// `hasAuth: false`.
async function usableGscopeTabs(preferTabId = null) {
  const all = await chrome.tabs.query({ url: `https://${GSCOPE_HOST}/*` });
  const usable = all.filter(t => isUsableGscopeUrl(t.url));
  // A tab that reached a real content page is no longer mid-prompt, so it
  // becomes re-drivable again once its session next expires.
  for (const t of usable) _foregroundedTabs.delete(t.id);
  if (preferTabId == null) return usable;
  const idx = usable.findIndex(t => t.id === preferTabId);
  if (idx <= 0) return usable;
  return [usable[idx], ...usable.slice(0, idx), ...usable.slice(idx + 1)];
}

// Open / find the gscope auth tab in BACKGROUND. Drives the SSO chain end-to-
// end via driveGscopeAuthChain (clicks Go on pfedprod AND wmstoresso). Per
// the suite-wide background-auth convention, never foregrounds tabs unless
// the chain stalls on a truly interactive page (Okta MFA etc), in which case
// _foregroundIfStillStuck pops the tab into its own window.
async function ensureGscopeAuthTab() {
  // Step 1: existing gscope tab on a usable content URL? Use it.
  const tabs = await chrome.tabs.query({ url: `https://${GSCOPE_HOST}/*` });
  const usable = tabs.filter(t => isUsableGscopeUrl(t.url));
  if (usable.length) return { ready: true, tabs: usable };

  // Step 2: a gscope tab exists but it's parked on an intermediate URL.
  //   - /api/wmstoresso: chain has reached gscope's store-select form. Click
  //     Go IN PLACE. DO NOT re-navigate to pfedprod — pfedprod silently
  //     bounces back to wmstoresso when AAD creds are cached, looping.
  //   - /api/sso* | /login: true dead-ends; re-start the chain at pfedprod.
  if (tabs.length) {
    const stuckTab = tabs[0];
    const isWmstoresso = stuckTab.url?.includes("/api/wmstoresso");
    await _spoofVisibility(stuckTab.id);
    if (!isWmstoresso) {
      try {
        await chrome.tabs.update(stuckTab.id, { url: SSO_START_URL, active: false });
      } catch (_) {}
    }
    const arrived = await driveGscopeAuthChain(stuckTab.id);
    console.log("[SparkFraud auth] step-2 drive (",
                isWmstoresso ? "click-go-on-wmstoresso" : "renav-via-pfedprod",
                ") arrived:", arrived);
    await _unspoofVisibility(stuckTab.id);
    if (arrived) {
      const usableNow = await usableGscopeTabs(stuckTab.id);
      if (usableNow.length) return { ready: true, tabs: usableNow, drivenTabId: stuckTab.id };
    }
    const interactive = await _foregroundIfStillStuck(stuckTab.id);
    if (interactive) return interactive;
    return {
      ready: false,
      reason: "auth-pending",
      message: "SSO in progress in the background tab. Click Find candidates again in a few seconds.",
      tabId: stuckTab.id,
    };
  }

  // Step 3: stored auth tab from a previous attempt (likely mid-chain on
  // pfedprod or wmstoresso)?
  const stored = (await chrome.storage.session.get(STORAGE_AUTH_TAB_KEY))[STORAGE_AUTH_TAB_KEY];
  if (stored) {
    try {
      await chrome.tabs.get(stored);
      await touchSessionTab(stored);
      await _spoofVisibility(stored);
      const arrived = await driveGscopeAuthChain(stored, 10_000);
      await _unspoofVisibility(stored);
      if (arrived) {
        const usableNow = await usableGscopeTabs(stored);
        if (usableNow.length) return { ready: true, tabs: usableNow, drivenTabId: stored };
      }
      const interactive = await _foregroundIfStillStuck(stored);
      if (interactive) return interactive;
      return {
        ready: false,
        reason: "auth-pending",
        message: "SSO still in progress in the background tab. Click Find candidates again in a few seconds.",
        tabId: stored,
      };
    } catch (_) {
      await chrome.storage.session.remove(STORAGE_AUTH_TAB_KEY);
    }
  }

  // Step 4: no tab exists — open our own and drive the chain.
  return openAndDriveOwnAuthTab();
}

// Open a blank background tab of OUR OWN, attach the debugger for the
// visibility spoof (so the SSO chain's intermediate pages aren't throttled),
// then navigate to pfedprod. driveGscopeAuthChain handles the Go-clicks on
// the pfedprod → wmstoresso → /apphome chain.
//
// Never a tab the user might be working in: this also runs when a perfectly
// good-looking gscope tab exists whose session has expired, and navigating that
// tab out from under the user to an SSO endpoint is exactly what
// `MEMORY.md::Never adopt a user's tab and navigate it` forbids.
//
// It IS allowed to re-drive the auth tab we opened on a previous attempt.
// Creating a fresh one every time meant a stalling chain left one dead tab per
// click of Find candidates (3 → 4 → 5 across three attempts in the reported
// log). The one exception is a tab _foregroundIfStillStuck has handed to the
// user: re-driving that navigates away from the MFA prompt they are in the
// middle of answering.
async function ourAuthTab() {
  const stored = (await chrome.storage.session.get(STORAGE_AUTH_TAB_KEY))[STORAGE_AUTH_TAB_KEY];
  if (stored != null && !_foregroundedTabs.has(stored)) {
    try {
      await chrome.tabs.get(stored);
      await touchSessionTab(stored);
      return { id: stored, reused: true };
    } catch (_) { /* tab is gone */ }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.storage.session.set({ [STORAGE_AUTH_TAB_KEY]: tab.id });
  // This tab BECOMES the working gscope tab once the SSO chain lands, so it
  // can't be closed when auth finishes — but it also shouldn't outlive the
  // session, which is what it used to do. Hand it to the idle reaper.
  await registerSessionTab(MODULE_ID, tab.id);
  return { id: tab.id, reused: false };
}

async function openAndDriveOwnAuthTab() {
  const tab = await ourAuthTab();
  await _spoofVisibility(tab.id);
  try {
    await chrome.tabs.update(tab.id, { url: SSO_START_URL, active: false });
  } catch (_) {}
  const arrived = await driveGscopeAuthChain(tab.id, 15_000);
  await _unspoofVisibility(tab.id);
  console.log("[SparkFraud auth] own-tab drive — tab:", tab.id,
              "reused:", tab.reused, "arrived:", arrived);
  if (arrived) {
    const usableNow = await usableGscopeTabs(tab.id);
    if (usableNow.length) return { ready: true, tabs: usableNow, drivenTabId: tab.id };
  }
  const interactive = await _foregroundIfStillStuck(tab.id);
  if (interactive) return interactive;
  return {
    ready: false,
    reason: "auth-opening",
    message: "Opened gscope SSO in a background tab — driving Go-clicks through the chain. " +
             "Click Find candidates again in a few seconds.",
    tabId: tab.id,
  };
}

// ── Exported handlers ──────────────────────────────────────────────────
export const handlers = {
  // Autonomous reauth for Swift. ensureGscopeAuthTab only checks the tab's
  // URL, so a gscope tab parked on /apphome with an expired authtoken looks
  // "ready" while Swift answers every Dispatcher call with an empty 400.
  // Reloading the tab re-runs gscope's bootstrap: cached AAD creds mint a
  // fresh token silently, or the tab lands on the SSO chain and we drive it
  // in the background exactly like a cold start. Caller re-reads cookies.
  async refreshGscopeAuth() {
    const log = (...a) => console.log("[SW refreshGscopeAuth]", ...a);
    try {
      const tabs = await chrome.tabs.query({ url: `https://${GSCOPE_HOST}/*` });
      if (!tabs.length) return { ok: false, error: "no gscope tab to refresh" };
      const usable = tabs.filter(t => isUsableGscopeUrl(t.url));
      const tab = usable[0] ?? tabs[0];
      log("reloading tab", tab.id, tab.url);
      const bootstrapped = await reloadTabAndWait(tab.id, { settleMs: 2_000, timeoutMs: 30_000 });
      if (!bootstrapped.ok) return { ok: false, error: `reload failed: ${bootstrapped.reason}` };
      const after = await chrome.tabs.get(tab.id).catch(() => null);
      if (after && isUsableGscopeUrl(after.url)) {
        log("tab back on content URL after reload");
        return { ok: true, tabId: tab.id, drove: false };
      }
      // Reload bounced into the SSO chain — drive it, background-only.
      await _spoofVisibility(tab.id);
      const arrived = await driveGscopeAuthChain(tab.id);
      await _unspoofVisibility(tab.id);
      log("drove SSO chain after reload, arrived:", arrived);
      if (arrived) return { ok: true, tabId: tab.id, drove: true };
      return { ok: false, error: "gscope SSO did not complete after reload", tabId: tab.id };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  async clearGscopeState() {
    try {
      const origins = [
        "https://gscope.walmartlabs.com",
        "https://gscope.walmart.com",
        "https://swift.walmart.com",
      ];
      await chrome.browsingData.remove(
        { origins },
        {
          cache:           true,
          cacheStorage:    true,
          cookies:         true,
          indexedDB:       true,
          localStorage:    true,
          serviceWorkers:  true,
        }
      );
      return { ok: true, cleared: origins };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  async getItemImage(msg) {
    try {
      const itemId = String(msg.itemId || "");
      if (!itemId) return { ok: false, error: "no itemId" };

      const cacheKey = `${STORAGE_IMG_PREFIX}${itemId}`;
      const cache = await chrome.storage.local.get(cacheKey);
      const entry = cache[cacheKey];
      // Positive cache: 7 days (item images change rarely).
      // Negative cache: 24 hours.
      const POSITIVE_TTL = 7 * 24 * 3600 * 1000;
      const NEGATIVE_TTL =     24 * 3600 * 1000;
      // v2 entries are the ones written after the redirect check below.
      // Older positive entries may hold a picture of some other product, so
      // they are refetched once rather than trusted for their 7 days.
      if (entry && entry.v === 2) {
        const age = Date.now() - entry.ts;
        const ttl = entry.url ? POSITIVE_TTL : NEGATIVE_TTL;
        if (age < ttl) {
          return { ok: !!entry.url, url: entry.url || null, cached: true };
        }
      }

      const r = await fetch(`https://www.walmart.com/ip/${encodeURIComponent(itemId)}`, {
        method: "GET",
        credentials: "omit",
      });
      // walmart.com does not 404 an item id it doesn't sell online. It
      // redirects to whatever listing its matcher likes — /ip/19239958105
      // (Apple & Eve apple juice, per OMS) landed on an iPhone, and the card
      // showed the phone. Only trust the page if its final URL still ends in
      // the id we asked for.
      const finalPath = (() => { try { return new URL(r.url).pathname; } catch { return ""; } })();
      const sameItem = !finalPath || finalPath.endsWith(`/${itemId}`);
      if (r.ok && !sameItem) {
        await chrome.storage.local.set({
          [cacheKey]: { v: 2, url: null, ts: Date.now(), redirectedTo: finalPath.slice(-40) },
        });
        return { ok: false, error: `walmart.com redirected to a different item (${finalPath.slice(-40)})` };
      }
      if (!r.ok) {
        await chrome.storage.local.set({
          [cacheKey]: { v: 2, url: null, ts: Date.now(), httpStatus: r.status },
        });
        return { ok: false, status: r.status, error: `walmart.com HTTP ${r.status}` };
      }
      const html = await r.text();
      const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      const url = m ? m[1] : null;
      if (!url) {
        await chrome.storage.local.set({
          [cacheKey]: { v: 2, url: null, ts: Date.now() },
        });
        return { ok: false, error: "no og:image found" };
      }
      await chrome.storage.local.set({
        [cacheKey]: { v: 2, url, ts: Date.now() },
      });
      return { ok: true, url, cached: false };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  async openOrderInDispatcher(msg) {
    try {
      const orderId = msg.orderId;
      if (!orderId) return { ok: false, error: "no orderId" };
      const targetUrl = "https://gscope.walmartlabs.com/mfe/spark/dashboard";
      const tab = await chrome.tabs.create({ url: targetUrl, active: true });
      await waitForTabUrl(tab.id, "/spark/dashboard", 30_000);
      await sleep(3_000);

      const result = await injectAndRetry(
        tab.id,
        async (orderId) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const icon = document.querySelector('[title="Global Search"]');
          if (!icon) return { ok: false, skipped: true };

          icon.click();
          await sleep(1200);

          let input = null;
          for (let i = 0; i < 15 && !input; i++) {
            const candidates = Array.from(document.querySelectorAll('input[type="text"]'))
              .filter(e => e.offsetParent !== null);
            if (candidates.length === 1) {
              input = candidates[0];
            } else if (candidates.length > 1) {
              input = candidates.find(e => /TextField-module_input/.test(e.className)) || candidates[0];
            }
            if (!input) await sleep(400);
          }
          if (!input) return { ok: false, error: "search input did not appear" };

          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value").set;
          setter.call(input, orderId);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(500);

          const btn = Array.from(document.querySelectorAll("button"))
            .find(b => /^search$/i.test((b.textContent || "").trim()));
          if (btn) {
            btn.click();
          } else {
            input.focus();
            input.dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
            }));
          }

          for (let i = 0; i < 14; i++) {
            await sleep(500);
            const inOrders = Array.from(document.querySelectorAll("button"))
              .find(b => /^in\s*orders?$/i.test((b.textContent || "").trim()));
            if (inOrders) {
              inOrders.click();
              return { ok: true, via: "search+in-orders", value: input.value };
            }
          }
          return { ok: true, via: "search-no-disambig", value: input.value };
        },
        [orderId],
        15,
        1500,
      );
      return { ok: result.ok, tabId: tab.id, ...result };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  // Drive Dispatcher's native driver search in a small focused popup window,
  // capture the response via window.__APAISUITE_SPARKFRAUD_CAP, return the
  // raw trip data to the caller (which renders it inline in our own popup).
  // The popup auto-closes when capture completes.
  //
  // Why a focused popup instead of a background tab: the Spark dashboard UI
  // (search icon, results) lives inside a cross-origin swift.walmart.com
  // iframe nested in the outer gscope shell. Two facts make a background
  // tab a dead end:
  //   1. CDP's Page.addScriptToEvaluateOnNewDocument does NOT propagate to
  //      cross-origin iframes (verified live). So the visibility spoof can't
  //      reach the swift iframe.
  //   2. The Spark SPA defers mounting when document.visibilityState='hidden',
  //      which is the iframe's state whenever the tab is in background.
  // Combined: the iframe stays empty forever in a background tab. A focused
  // popup keeps the iframe's vis='visible' so the SPA mounts normally.
  //
  // The popup is small (600×400 in the top-left corner) to minimize visual
  // disruption. The user briefly loses focus from the extension tab, but the
  // popup auto-closes within ~10s.
  async openDriverInDispatcher(msg) {
    let helperWin = null;
    try {
      const driverName = String(msg.driverName || "").trim();
      if (!driverName) return { ok: false, error: "no driverName" };
      const targetUrl = "https://gscope.walmartlabs.com/mfe/spark/dashboard";

      helperWin = await chrome.windows.create({
        url: targetUrl,
        type: "popup",
        width: 600, height: 400, top: 50, left: 50,
        focused: true,
      });
      const helperTabId = helperWin.tabs[0].id;

      await waitForTabUrl(helperTabId, "/spark/dashboard", 30_000);
      // The cross-origin swift iframe loads ~3-5s after the outer gscope
      // shell. Sleep long enough for the iframe to attach and the SPA to
      // start mounting before we poll for the search icon.
      await sleep(5000);

      const result = await chrome.scripting.executeScript({
        target: { tabId: helperTabId, allFrames: true },
        world: "MAIN",
        args: [driverName, CAPTURE_GLOBAL_NAME],
        func: async (driverName, capName) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));

          // The Spark dashboard UI lives inside the swift.walmart.com iframe.
          // Walmart serves either /sparkApp/* (wide layout) or /responsive/*
          // (narrow layout) depending on viewport — match on the host alone.
          if (!location.host.includes("swift.walmart.com")) {
            return { ok: false, skipped: "wrong-frame", url: location.href };
          }

          let icon = null;
          for (let i = 0; i < 30 && !icon; i++) {
            icon = document.querySelector('[title="Global Search"]');
            if (!icon) await sleep(500);
          }
          if (!icon) {
            return {
              ok: false,
              error: "global-search-icon-missing",
              diag: {
                visibilityState: document.visibilityState,
                bodyChildren: document.body?.children?.length ?? 0,
                titleAttrSample: Array.from(document.querySelectorAll("[title]"))
                  .slice(0, 12)
                  .map(e => e.getAttribute("title")),
              },
            };
          }
          icon.click();
          await sleep(1200);

          // Find the search input.
          let input = null;
          for (let i = 0; i < 30 && !input; i++) {
            const candidates = Array.from(document.querySelectorAll('input[type="text"]'))
              .filter(e => e.offsetParent !== null);
            if (candidates.length === 1) {
              input = candidates[0];
            } else if (candidates.length > 1) {
              input = candidates.find(e => /TextField-module_input/.test(e.className)) || candidates[0];
            }
            if (!input) await sleep(400);
          }
          if (!input) return { ok: false, error: "search-input-not-found" };

          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value").set;
          setter.call(input, driverName);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(500);

          const searchBtn = Array.from(document.querySelectorAll("button"))
            .find(b => /^search$/i.test((b.textContent || "").trim()));
          if (searchBtn) {
            searchBtn.click();
          } else {
            input.focus();
            input.dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
            }));
          }

          // Wait for "In drivers" disambiguation button.
          let inDriversBtn = null;
          for (let i = 0; i < 20 && !inDriversBtn; i++) {
            await sleep(500);
            inDriversBtn = Array.from(document.querySelectorAll("button"))
              .find(b => /^in\s*drivers?$/i.test((b.textContent || "").trim()));
          }
          if (!inDriversBtn) return { ok: false, error: "in-drivers-button-not-found" };
          const clickTs = Date.now();
          inDriversBtn.click();

          // Watch the in-page capture buffer for the driver-search response.
          const cap = window[capName] || [];
          for (let i = 0; i < 30; i++) {
            await sleep(500);
            const candidates = cap.filter(e =>
              e.ts >= clickTs &&
              e.responseText !== undefined &&
              e.responseStatus === 200 &&
              (
                e.url.includes("/dashboard") ||
                e.url.includes("driver") ||
                e.url.includes("/trip")
              )
            );
            if (candidates.length) {
              candidates.sort((a, b) => (b.responseText.length - a.responseText.length));
              return {
                ok: true,
                url: candidates[0].url,
                method: candidates[0].method,
                text: candidates[0].responseText,
                capSize: cap.length,
                candidateCount: candidates.length,
              };
            }
          }
          return { ok: false, error: "no-driver-response-captured", capSize: cap.length };
        },
      });

      // executeScript with allFrames returns one entry per frame. Find the
      // first frame whose result is ok (the swift iframe — others either
      // skip themselves or are about:blank). If nothing succeeded, fall
      // through to the first error result so the caller sees a meaningful
      // diag (icon-missing, search-input-not-found, etc.).
      const r = result?.find(x => x?.result?.ok)?.result
             ?? result?.find(x => x?.result && x.result.skipped !== "wrong-frame")?.result
             ?? result?.[0]?.result;
      if (!r) return { ok: false, error: "executeScript returned nothing" };
      if (!r.ok) return r;

      let data = null;
      try { data = JSON.parse(r.text); } catch (_) {}

      return {
        ok: true,
        url: r.url,
        method: r.method,
        data,
        snippet: (r.text || "").slice(0, 400),
        capSize: r.capSize,
        candidateCount: r.candidateCount,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      if (helperWin) {
        try { await chrome.windows.remove(helperWin.id); } catch (_) {}
      }
    }
  },

  async openOrderInGscope(msg) {
    try {
      const orderId = msg.orderId;
      if (!orderId) return { ok: false, error: "no orderId" };
      const targetUrl = "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution";
      const tab = await chrome.tabs.create({ url: targetUrl, active: true });

      await waitForTabUrl(tab.id, "/orderresolution", 30_000);
      await sleep(4_000);

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        args: [orderId],
        func: async (orderId) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          let input = null;
          for (let i = 0; i < 10 && !input; i++) {
            input = document.querySelector('input[name="orderNo"]');
            if (!input) await sleep(500);
          }
          if (!input) return { ok: false, error: "orderNo input not found" };
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value").set;
          setter.call(input, orderId);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(300);
          const btn = Array.from(document.querySelectorAll("button"))
            .find(b => /view\s*details/i.test(b.textContent || ""));
          if (!btn) return { ok: false, error: "VIEW DETAILS button not found" };
          btn.click();
          return { ok: true };
        },
      });
      return { ok: true, tabId: tab.id };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  async driveOrderResolution(msg) {
    let helperTab = null;
    try {
      const orderIds = msg.orderIds || [];
      if (!orderIds.length) return { ok: false, error: "no order ids" };
      const targetUrl = "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution";

      // FAST PATH ──────────────────────────────────────────────────
      const cached = (await chrome.storage.session.get(STORAGE_OMS_HEADERS_KEY))[STORAGE_OMS_HEADERS_KEY];
      if (cached) {
        const gscopeTabs = await chrome.tabs.query({ url: "https://gscope.walmartlabs.com/*" });
        if (gscopeTabs.length) {
          try {
            const url = "https://gscope.walmartlabs.com/api/gateway/provider-oms/orders" +
                        `?limit=200&offset=0&orderNo=${encodeURIComponent(orderIds.join(","))}`;
            const [{ result }] = await chrome.scripting.executeScript({
              target: { tabId: gscopeTabs[0].id },
              args: [url, cached],
              func: async (url, headers) => {
                try {
                  const r = await fetch(url, {
                    method: "GET", headers, credentials: "include",
                  });
                  return { ok: r.ok, status: r.status, text: await r.text() };
                } catch (e) { return { ok: false, status: 0, error: String(e) }; }
              },
            });
            if (result?.ok && result.status === 200) {
              let data = null;
              try { data = JSON.parse(result.text); } catch (_) {}
              return { ok: true, status: 200, data, snippet: result.text.slice(0, 300), via: "fast-replay" };
            }
            // 401/403: stale headers, clear and fall through
            await chrome.storage.session.remove(STORAGE_OMS_HEADERS_KEY);
          } catch (_) { /* fall through to slow path */ }
        }
      }

      // SLOW PATH (drive the UI, capture headers for next time) ───
      helperTab = await chrome.tabs.create({ url: targetUrl, active: false });
      await waitForTabUrl(helperTab.id, "/orderresolution", 30_000);
      await sleep(5_000);

      const result = await injectAndRetry(
        helperTab.id,
        async (orderIds, captureGlobalName) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const startTs = Date.now();
          const perfStart = performance.now();

          // The form lives in the top document. Child frames (Quantum
          // Metric's hidden about:blank, any embedded MFE) bail at once so
          // they don't hold the whole executeScript open while they poll.
          if (window !== window.top) return { ok: false, skipped: true };

          // Wait for the MFE to render the form rather than returning
          // "skipped" and burning a retry: on a busy browser the Order
          // Resolution SPA can take well past the 5s post-load sleep to mount.
          let input = null;
          for (let i = 0; i < 40 && !input; i++) {
            input = document.querySelector('input[name="orderNo"]');
            if (!input) await sleep(500);
          }
          if (!input) return { ok: false, error: "Order Resolution form did not appear within 20s" };

          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, orderIds.join(","));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));

          await sleep(300);
          const buttons = Array.from(document.querySelectorAll("button"));
          const viewBtn = buttons.find(b => /view\s*details/i.test(b.textContent || ""));
          if (!viewBtn) return { ok: false, error: "VIEW DETAILS button not found" };
          viewBtn.click();

          const cap = window[captureGlobalName] || [];
          for (let i = 0; i < 60; i++) {
            await sleep(500);
            const hit = cap.find(e =>
              e.url.includes("/provider-oms/orders") &&
              e.ts >= startTs &&
              e.responseText !== undefined
            );
            if (hit) {
              return {
                ok: true, status: 200,
                text: hit.responseText, url: hit.url,
                capturedHeaders: hit.headers,
              };
            }
          }
          // Say WHICH half failed. Resource timing sees the request whether
          // or not any capture script did, so "fired but not captured" (a
          // capture-script regression, like 2026-08-20's) is distinguishable
          // from "never fired" (the click did nothing) from here.
          const fired = performance.getEntriesByType("resource")
            .some(r => r.name.includes("/provider-oms/orders") && r.startTime >= perfStart);
          const seen = cap.filter(e => e.url && e.url.includes("/provider-oms/orders") && e.ts >= startTs).length;
          return {
            ok: false,
            error: !fired
              ? "clicked View details but no /provider-oms request fired in 30s"
              : seen
                ? "/provider-oms request captured but its response never arrived in 30s"
                : `/provider-oms request fired but the capture script did not see it ` +
                  `(buffer ${Array.isArray(window[captureGlobalName]) ? "present" : "MISSING"}, ` +
                  `${cap.length} entries)`,
          };
        },
        [orderIds, CAPTURE_GLOBAL_NAME],
        // Two attempts, not five: each is up to ~50s (20s form wait + 30s
        // capture wait) and the view gives up on the whole message at 150s.
        // Five attempts meant the view always saw a bare messaging timeout
        // while the worker kept clicking View details in a tab nobody was
        // going to read. The form wait is inside the attempt now, so the
        // second attempt only ever re-clicks a form that exists.
        2,
        2000,
      );

      if (!result.ok) return { ok: false, error: result.error || "drive failed" };
      if (result.capturedHeaders) {
        const clean = {};
        const skip = new Set(["host", "content-length", "cookie", "user-agent",
                               ":authority", ":method", ":path", ":scheme", "origin",
                               "referer", "accept-encoding", "connection"]);
        for (const k of Object.keys(result.capturedHeaders)) {
          if (!skip.has(k.toLowerCase())) clean[k] = result.capturedHeaders[k];
        }
        await chrome.storage.session.set({ [STORAGE_OMS_HEADERS_KEY]: clean });
      }
      let data = null;
      try { data = JSON.parse(result.text); } catch (_) { data = result.text; }
      return { ok: true, status: result.status, data, snippet: (result.text || "").slice(0, 300), via: "slow-drive" };
    } catch (e) {
      return { ok: false, error: String(e) };
    } finally {
      if (helperTab) {
        try { await chrome.tabs.remove(helperTab.id); } catch (_) {}
      }
    }
  },

  async getCapturedRequest(msg) {
    try {
      const tabs = await chrome.tabs.query({
        url: "https://gscope.walmartlabs.com/*",
      });
      let best = null;
      for (const tab of tabs) {
        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            args: [CAPTURE_GLOBAL_NAME],
            func: (captureGlobalName) => window[captureGlobalName] || [],
          });
          for (const entry of result || []) {
            if (entry.url.includes(msg.urlSubstr)) {
              if (!best || entry.ts > best.ts) best = entry;
            }
          }
        } catch (e) { /* tab might be unloaded */ }
      }
      return { ok: true, capture: best };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  async fetchJson(msg) {
    try {
      const isGscope = msg.url.includes("gscope.walmartlabs.com");
      if (isGscope) {
        const tabs = await chrome.tabs.query({
          url: "https://gscope.walmartlabs.com/*",
        });
        if (!tabs.length) {
          return {
            ok: false, status: 0,
            error: "Open https://gscope.walmartlabs.com/apphome in a tab first.",
          };
        }

        const cleanHeaders = { "content-type": "application/json" };

        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          args: [msg.url, msg.method || "GET", cleanHeaders, msg.body || null],
          func: async (url, method, headers, body) => {
            try {
              const r = await fetch(url, {
                method,
                headers,
                credentials: "include",
                body: body ? JSON.stringify(body) : undefined,
              });
              const text = await r.text();
              return { ok: r.ok, status: r.status, text };
            } catch (e) {
              return { ok: false, status: 0, error: String(e) };
            }
          },
        });
        if (result.error) return { ok: false, status: result.status, error: result.error };
        let data = null;
        try { data = JSON.parse(result.text); } catch (_) { data = result.text; }
        return { ok: result.ok, status: result.status, data, snippet: result.text.slice(0, 300) };
      }

      // swift.walmart.com (cross-origin from extension is fine — uses
      // header-based auth via x-authheader/x-authtoken, no cookies needed).
      //
      // `credentials: "include"` still ships every cookie scoped to
      // swift.walmart.com / .walmart.com. That jar grows with every SSO
      // round-trip across Walmart sites, and once the Cookie header pushes
      // the request past Tomcat's header limit Swift answers with its stock
      // "HTTP Status 400 – Bad Request" HTML page — before the Dispatcher
      // app ever sees the call. Measure the jar, and if a cookie-bearing
      // attempt comes back as a container-level 400, retry without cookies.
      const doFetch = async (credentials) => {
        const r = await fetch(msg.url, {
          method: msg.method || "GET",
          headers: msg.headers || {},
          credentials,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        return { ok: r.ok, status: r.status, data, text };
      };
      const isContainer400 = (r) =>
        r.status === 400 && typeof r.data === "string" && /HTTP Status 400/i.test(r.data);

      let cookieBytes = -1;
      try {
        const jar = await chrome.cookies.getAll({ url: msg.url });
        cookieBytes = jar.reduce((n, c) => n + c.name.length + c.value.length + 3, 0);
        console.log(`[SW fetchJson] swift cookie jar: ${jar.length} cookie(s), ~${cookieBytes} bytes on the Cookie header`);
      } catch (_) {}

      let r = await doFetch("include");
      let credentialsUsed = "include";
      if (isContainer400(r)) {
        console.warn(`[SW fetchJson] container-level 400 with cookies (~${cookieBytes}B) — retrying with credentials: "omit"`);
        const r2 = await doFetch("omit");
        if (!isContainer400(r2)) { r = r2; credentialsUsed = "omit"; }
      }
      const { text: _t, ...rest } = r;
      return { ...rest, diag: { credentialsUsed, cookieBytes } };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    }
  },

  async getGscopeCookies() {
    const log = (...a) => console.log("[SW getGscopeCookies]", ...a);
    try {
      log("start");
      const authRes = await ensureGscopeAuthTab();
      if (!authRes.ready) {
        log("auth not ready:", authRes.reason);
        return {
          ok: false,
          error: authRes.reason,         // "auth-opening" | "auth-pending"
          message: authRes.message,
          tabId: authRes.tabId,
        };
      }
      let tabs = authRes.tabs;
      log("tabs found:", tabs.length, tabs.map(t => `${t.id}:${t.url}`));

      let read = await readCookiesFromTabs(tabs, log);
      let drivenTabId = authRes.drivenTabId ?? null;

      // An EXPIRED session is the one state ensureGscopeAuthTab cannot see.
      // Its step 1 accepts any gscope tab whose URL is not on the stuck list,
      // and an expired session leaves a tab sitting on /apphome — a perfectly
      // usable-looking URL with cookies but no authToken. So the readiness
      // test passed, no step ever drove the SSO chain, and this branch used to
      // dead-end by telling the user to go sign in by hand. That is the bug:
      // the background-auth convention is "don't FOREGROUND a tab", not
      // "don't re-authenticate".
      //
      // Drive the chain once, in a tab of our own, then re-read. Once at most,
      // because a second failure means the chain needs a human (MFA, a
      // password prompt) and retrying just burns tabs.
      if (read.cookies && !hasAuthCookies(read.cookies)) {
        log("cookies present but no authToken — session expired; driving SSO in our own tab",
            "— had:", Object.keys(read.cookies).sort().join(","));
        const reauth = await openAndDriveOwnAuthTab();
        if (reauth.ready) {
          // reauth.tabs is ordered driven-tab-first by usableGscopeTabs, which
          // is the whole point: reading the analyst's stale /apphome tab after
          // a successful re-auth is how this used to report hasAuth: false.
          tabs = reauth.tabs;
          drivenTabId = reauth.drivenTabId ?? drivenTabId;
          const retry = await readCookiesFromTabs(tabs, log);
          if (retry.cookies) read = retry;
          log("post-reauth cookie read:", read.cookies ? Object.keys(read.cookies).length : 0,
              "hasAuth:", read.cookies ? hasAuthCookies(read.cookies) : false,
              "names:", read.cookies ? Object.keys(read.cookies).sort().join(",") : "—",
              "drivenTab:", reauth.drivenTabId, "readFrom:", read.usedTab?.id);
        } else {
          // The chain stalled — either mid-flight ("auth-opening") or on a
          // page only a human can clear ("auth-needs-interaction", which
          // _foregroundIfStillStuck has already surfaced in its own window).
          // Hand back the same shape the not-ready path uses so the UI says
          // what is actually happening rather than "your session may have
          // expired".
          log("reauth did not land:", reauth.reason);
          return {
            ok: false,
            error: reauth.reason || "auth-pending",
            message: reauth.message,
            tabId: reauth.tabId,
            stuckUrl: reauth.stuckUrl,
          };
        }
      }

      if (!read.cookies) {
        return { ok: false, error: "All gscope tabs unresponsive — try refreshing one" };
      }
      const { cookies, usedTab } = read;

      if (!hasAuthCookies(cookies)) {
        // Re-auth was attempted above and did not produce auth cookies. Per
        // the background-auth convention the tab is still not foregrounded
        // here — _foregroundIfStillStuck already had its chance inside
        // openAndDriveOwnAuthTab, and it declined, meaning the page looks
        // usable but is not authenticating.
        return {
          ok: false,
          error: "auth-cookies-missing",
          message: "Signed-in session could not be established automatically — the SSO chain " +
                   "completed but gscope issued no auth cookies. Open " +
                   "https://gscope.walmartlabs.com/apphome to sign in, then click Find candidates again.",
          diag: {
            tabUrl: usedTab.url,
            reauthAttempted: true,
            // Which tab the chain was actually driven in, and where it ended
            // up. Without this the message above asserts "the SSO chain
            // completed" on no evidence — that claim was wrong for the whole
            // life of the substring readiness bug, and it sent three separate
            // investigations looking at cookies instead of at the chain.
            drivenTabId,
            drivenTabUrl: drivenTabId != null
              ? await chrome.tabs.get(drivenTabId).then(t => t.url).catch(() => "(tab gone)")
              : null,
            readFromTabId: usedTab.id,
            cookieCount: Object.keys(cookies).length,
            cookieNames: Object.keys(cookies).sort(),
          },
        };
      }

      // Cookies are inconsistently cased across gscope services, so lowercase
      // once for the identity read. The caller does its own lowercasing for
      // header building; this must not depend on that happening.
      const ciCookies = {};
      for (const k of Object.keys(cookies)) ciCookies[k.toLowerCase()] = cookies[k];
      recordGscopeIdentity(ciCookies);

      return {
        ok: true,
        cookies,
        diag: {
          method: "readCookiesViaTab",
          tabUrl: usedTab.url,
          cookieCount: Object.keys(cookies).length,
          cookieNames: Object.keys(cookies).sort(),
        },
      };
    } catch (e) {
      log("ERROR:", e);
      return { ok: false, error: String(e) };
    }
  },

  // ── Watchlist handlers ────────────────────────────────────────────
  // Storage shape:
  //   sparkfraud.watchlist        = [{ driverName, store, addedAt }]
  //   sparkfraud.watchlist_state  = { "<driverName>|<store>": { lastStatus, lastSeenMs, lastTripId, lastOrderIds } }
  //   sparkfraud.watchlist_hits   = [{ driverName, store, status, tripId, orderIds, hitAt, itemsByOrder? }, ...max N]

  // Given a list of order IDs and a store, finds the matching Dispatcher trips
  // and returns { orderId → { firstName, lastName, carrier, displayTripStatus } }.
  // Best-effort — requires gscope auth. Used by the OMS order-lookup flow so
  // the watchlist gets a real driver name instead of the "Looked up via OMS" sentinel.
  async resolveOrderDrivers(msg) {
    const orderIds = (msg.orderIds || []).filter(Boolean);
    const store    = String(msg.store || "").trim();
    if (!orderIds.length || !store) return { ok: false, error: "orderIds + store required" };

    const hdrRes = await _buildSwiftHeaders();
    if (!hdrRes.ok) return { ok: false, error: "auth-not-ready", reason: hdrRes.reason };

    const now   = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const end   = new Date(now.getTime() + 12 * 60 * 60_000);
    const body  = {
      startTime:      start.toISOString(),
      endTime:        end.toISOString(),
      pickupPointIds: [store],
      clients:        ["0"],
      pageSize:       200,
      services:       ["PICKING", "PICKING_DELIVERY", "DELIVERY"],
    };
    const r = await fetch(SWIFT_DASHBOARD_URL, {
      method: "POST", headers: hdrRes.headers, credentials: "include",
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `Dispatcher HTTP ${r.status}` };
    const data  = await r.json();
    const trips = data?.payload?.tasksByClientId?.["0"]?.trips || [];

    const wantIds  = new Set(orderIds);
    const driverMap = {};
    for (const t of trips) {
      const matched = (t.orders || []).map(o => o.orderId).filter(oid => wantIds.has(oid));
      if (!matched.length) continue;
      const d = t.driver || {};
      for (const oid of matched) {
        driverMap[oid] = {
          firstName:         d.firstName         || "",
          lastName:          d.lastName          || "",
          carrier:           t.carrier           || "",
          displayTripStatus: t.displayTripStatus || "",
        };
      }
    }
    return { ok: true, driverMap };
  },

  async watchlist_add(msg) {
    const driverName = String(msg.driverName || "").trim();
    const store = String(msg.store || "").trim();
    if (!driverName || !store) return { ok: false, error: "driverName + store required" };
    const list = await _readWatchlist();
    const key = _wlKey({ driverName, store });
    const dup = list.find(e => _wlKey(e) === key);

    // Seed the per-driver state row when the caller passes initialState
    // (e.g. clicking + Watch on a trip card — we have the trip's current
    // status + last-seen time already). The polling alarm will overwrite
    // these as it observes new data; the seed just gives the UI something
    // meaningful to show in the gap before the first poll.
    if (msg.initialState) {
      const state = await _readWatchlistState();
      const seeded = {
        lastStatus:   msg.initialState.lastStatus   ?? null,
        lastSeenMs:   msg.initialState.lastSeenMs   ?? null,
        lastTripId:   msg.initialState.lastTripId   ?? null,
        lastOrderIds: msg.initialState.lastOrderIds ?? [],
        seedSource:   msg.initialState.seedSource   ?? "manual",
      };
      // For an EXISTING entry: only seed if the new seed is more recent than
      // what we already have (don't blow away polled state with stale data).
      const prev = state[key];
      if (!prev?.lastSeenMs || (seeded.lastSeenMs ?? 0) >= prev.lastSeenMs) {
        state[key] = { ...prev, ...seeded };
        await chrome.storage.local.set({ [STORAGE_WATCHLIST_STATE_KEY]: state });
      }
    }

    if (dup) return { ok: true, alreadyWatching: true, watchlist: list };
    list.push({ driverName, store, addedAt: Date.now() });
    await chrome.storage.local.set({ [STORAGE_WATCHLIST_KEY]: list });

    // Auto-evict any stale "Looked up via OMS" entries at the same store
    // whose tracked order IDs overlap with this new real-driver entry.
    // Happens when the user looked up by order first, then found the driver
    // via store search and clicked Watch — the OMS entry is now superseded.
    const newOrderIds = new Set(msg.initialState?.lastOrderIds ?? []);
    if (newOrderIds.size && driverName !== "Looked up via OMS") {
      const state = await _readWatchlistState();
      const OMS_SENTINEL = "Looked up via OMS";
      const omsKeys = list
        .filter(e => e.driverName === OMS_SENTINEL && e.store === store)
        .filter(e => {
          const entryOrders = state[_wlKey(e)]?.lastOrderIds ?? [];
          return entryOrders.some(oid => newOrderIds.has(oid));
        })
        .map(e => _wlKey(e));
      if (omsKeys.length) {
        const pruned = list.filter(e => !omsKeys.includes(_wlKey(e)));
        for (const k of omsKeys) delete state[k];
        await chrome.storage.local.set({
          [STORAGE_WATCHLIST_KEY]: pruned,
          [STORAGE_WATCHLIST_STATE_KEY]: state,
        });
        console.info(`[SparkFraud watchlist] auto-evicted ${omsKeys.length} OMS placeholder entry(s) superseded by ${driverName}`);
      }
    }

    await _ensureWatchlistAlarm();
    return { ok: true, added: true, watchlist: list };
  },

  async watchlist_remove(msg) {
    const driverName = String(msg.driverName || "").trim();
    const store = String(msg.store || "").trim();
    if (!driverName || !store) return { ok: false, error: "driverName + store required" };
    const list = await _readWatchlist();
    const key = _wlKey({ driverName, store });
    const next = list.filter(e => _wlKey(e) !== key);
    await chrome.storage.local.set({ [STORAGE_WATCHLIST_KEY]: next });
    // Also drop the per-driver state entry so re-adding starts fresh.
    const state = await _readWatchlistState();
    delete state[key];
    await chrome.storage.local.set({ [STORAGE_WATCHLIST_STATE_KEY]: state });
    return { ok: true, watchlist: next };
  },

  async watchlist_list() {
    const list = await _readWatchlist();
    const state = await _readWatchlistState();
    // Annotate each entry with last-known status for the UI.
    const annotated = list.map(e => ({
      ...e,
      lastStatus:  state[_wlKey(e)]?.lastStatus ?? null,
      lastSeenMs:  state[_wlKey(e)]?.lastSeenMs ?? null,
      lastTripId:  state[_wlKey(e)]?.lastTripId ?? null,
      lastOrderIds: state[_wlKey(e)]?.lastOrderIds ?? [],
    }));
    return { ok: true, watchlist: annotated };
  },

  async watchlist_hits_list() {
    const cutoff = Date.now() - WATCHLIST_TTL_MS;
    const all = (await chrome.storage.local.get(STORAGE_WATCHLIST_HITS_KEY))[STORAGE_WATCHLIST_HITS_KEY] || [];
    const hits = all.filter(h => (h.hitAt || 0) >= cutoff);
    return { ok: true, hits };
  },

  async watchlist_clear_hits() {
    await chrome.storage.local.remove(STORAGE_WATCHLIST_HITS_KEY);
    return { ok: true };
  },

  // Manual trigger for the poll — exposed for "Check now" button in the UI.
  async watchlist_poll_now() {
    try {
      const result = await pollWatchlist({ trigger: "manual" });
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  },
};

// ── Watchlist internals ──────────────────────────────────────────────

function _wlKey(e) { return `${e.driverName}|${e.store}`; }

async function _readWatchlist() {
  const all = (await chrome.storage.local.get(STORAGE_WATCHLIST_KEY))[STORAGE_WATCHLIST_KEY] || [];
  const cutoff = Date.now() - WATCHLIST_TTL_MS;
  const live = all.filter(e => (e.addedAt || 0) >= cutoff);
  if (live.length !== all.length) {
    // Write back the pruned list and clean up orphaned state entries.
    await chrome.storage.local.set({ [STORAGE_WATCHLIST_KEY]: live });
    const expired = all.filter(e => (e.addedAt || 0) < cutoff);
    if (expired.length) {
      const state = await _readWatchlistState();
      for (const e of expired) delete state[_wlKey(e)];
      await chrome.storage.local.set({ [STORAGE_WATCHLIST_STATE_KEY]: state });
      console.info(`[SparkFraud watchlist] purged ${expired.length} expired entries (>72h)`);
    }
  }
  return live;
}

async function _readWatchlistState() {
  return (await chrome.storage.local.get(STORAGE_WATCHLIST_STATE_KEY))[STORAGE_WATCHLIST_STATE_KEY] || {};
}

// Lazily cached enums.json#watchlist config (active_statuses, poll cadence).
let _watchlistConfig = null;
async function _getWatchlistConfig() {
  if (_watchlistConfig) return _watchlistConfig;
  try {
    const r = await fetch(ENUMS_URL);
    const enums = await r.json();
    _watchlistConfig = enums?.watchlist ?? {};
  } catch (e) {
    console.warn("[SparkFraud watchlist] enums.json load failed; using defaults:", e);
    _watchlistConfig = {};
  }
  // Defaults if registry hasn't been seeded.
  _watchlistConfig.active_statuses        ??= ["enrouteToPickup", "atPickup", "tripInProgress"];
  _watchlistConfig.poll_interval_minutes  ??= 3;
  _watchlistConfig.dispatcher_window_minutes ??= 120;
  _watchlistConfig.max_hits_retained      ??= 100;
  return _watchlistConfig;
}

// Register / refresh the periodic alarm. Called on every watchlist_add and at
// SW boot (see below).
//
// This used to call chrome.alarms.create() directly, on the stated belief that
// "chrome.alarms is idempotent — re-creating an alarm with the same name
// replaces the previous one". Both halves are true and together they are the
// bug: replacing RESTARTS the period from zero. Since this also runs at the
// top level of a file the shell page imports, every suite page load reset the
// poll countdown — a watchlist with a 15-minute interval never polled for
// anyone who opened the suite more often than that. ensureAlarm() only writes
// when the alarm is missing or the configured interval actually changed, which
// is still exactly what watchlist_add needs. See shared/alarms.js.
async function _ensureWatchlistAlarm() {
  const cfg = await _getWatchlistConfig();
  await ensureAlarm(ALARM_NAME, { periodInMinutes: cfg.poll_interval_minutes });
}

// ── Alarm listener — MUST be registered synchronously at module top level
// so chrome.alarms wakes the SW on tick. Same rule as chrome.webRequest.
//
// Gated to the service worker: this file is imported by the shell page too,
// and extension pages receive alarm events as well — an ungated listener
// polls the watchlist twice per tick, once here and once in every open suite
// tab, each driving its own Dispatcher queries.
if (IS_SERVICE_WORKER) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    pollWatchlist({ trigger: "alarm" }).catch(e => {
      console.error("[SparkFraud watchlist] poll threw:", e);
    });
  });

  // Create the alarm at SW boot too. chrome.alarms.create can run after async
  // work has begun — Chrome remembers the alarm regardless.
  _ensureWatchlistAlarm().catch(e => {
    console.warn("[SparkFraud watchlist] alarm setup failed:", e);
  });
}

// ── Headers for the SW-side Dispatcher query ─────────────────────────
// Mirrors the buildHeaders() function in view.js but executes inside the
// SW. Needed by pollWatchlist (the alarm fires while no UI is open).
async function _buildSwiftHeaders() {
  const authRes = await ensureGscopeAuthTab();
  if (!authRes.ready) {
    return { ok: false, reason: authRes.reason, message: authRes.message };
  }
  let tabs = authRes.tabs;
  let read = await readCookiesFromTabs(tabs);

  // Same expired-session blind spot the UI path has: ensureGscopeAuthTab
  // judges readiness by URL, so a tab parked on /apphome with a dead session
  // reads as ready. This runs from the watchlist alarm with no UI open, so
  // there is nobody to show a "go sign in" message to — driving the chain in
  // the background is the only thing that can fix it.
  if (read.cookies && !hasAuthCookies(read.cookies)) {
    console.log("[SparkFraud auth] watchlist poll: session expired — driving SSO in our own tab");
    try { await chrome.storage.session.remove(STORAGE_AUTH_TAB_KEY); } catch (_) {}
    const reauth = await openAndDriveOwnAuthTab();
    if (reauth.ready) {
      tabs = reauth.tabs;
      const retry = await readCookiesFromTabs(tabs);
      if (retry.cookies) read = retry;
    } else {
      return { ok: false, reason: reauth.reason, message: reauth.message };
    }
  }

  const cookies = read.cookies;
  if (!cookies) return { ok: false, reason: "no-cookies", message: "Couldn't read gscope cookies" };

  // Lowercase keys for case-insensitive lookup (cookies are inconsistently
  // cased — `loginid` vs `loginId` etc).
  const ci = {};
  for (const k of Object.keys(cookies)) ci[k.toLowerCase()] = cookies[k];
  if (!hasAuthCookies(cookies)) {
    return {
      ok: false, reason: "auth-cookies-missing",
      message: "gscope auth cookies missing after an automatic re-auth attempt",
    };
  }
  recordGscopeIdentity(ci);

  const loginId      = ci.loginid || "";
  const display      = ci.displayname || "";
  let   loginIdOut   = loginId;
  let   displayOut   = display;
  // Walmart's gscope ships displayname/loginid as empty — user identity is now
  // in wire-id (format: "Display Name - loginId"). Mirrors the view.js fallback.
  if ((!displayOut || !loginIdOut) && ci["wire-id"]) {
    const m = ci["wire-id"].match(/^(.*?)\s*-\s*([^-\s][^-]*?)\s*$/);
    if (m) {
      if (!displayOut)  displayOut  = m[1].trim();
      if (!loginIdOut)  loginIdOut  = m[2].trim();
    } else if (!displayOut) {
      displayOut = ci["wire-id"];
    }
  }
  const storeId      = ci["store-no"] || ci.storeno || "";
  const loggedDomain = ci.loggedindomain || "store";
  const loggedUser   = ci.loggedinusername || "";
  const firstName    = displayOut.split(" ")[0] || "";
  const lastName     = displayOut.split(" ").slice(1).join(" ") || "";

  return {
    ok: true,
    headers: {
      "content-type":          "application/json",
      "x-authheader":          ci.authheader || "",
      "x-authtoken":           ci.authtoken  || "",
      "x-userid":              loginIdOut,
      "x-username":            displayOut,
      "x-firstname":           firstName,
      "x-lastname":            lastName,
      "x-loggedindomain":      loggedDomain,
      "x-loggedinusername":    loggedUser,
      "x-storeid":             storeId,
      "x-realmid":             "DISPATCHER_WEB_UI",
      "x-source":              "DISPATCHER",
      "x-sourceapp":           "DISPATCHER_WEB_UI",
      "x-channel":             "WEB",
      "x-domain":              "USLM",
      "x-tenant":              "WALMART_US",
      "x-tenantid":            "0",
      "tenantid":              "0",
      "wm_tenant_id":          "0",
      "wm_consumer.tenant_id": "0",
      "x-timezone":            "+00:00",
      "device_timezone":       "America/New_York",
      "installed_app":         "spark-dispatcher.us",
    },
  };
}

async function _fetchDispatcherTrips(headers, store, windowMinutes) {
  const now = new Date();
  const start = new Date(now.getTime() - windowMinutes * 60_000);
  const end   = new Date(now.getTime() + windowMinutes * 60_000);
  // Simple ISO without TZ offset is acceptable — dispatcher accepts UTC Z.
  const body = {
    startTime: start.toISOString(),
    endTime:   end.toISOString(),
    pickupPointIds: [String(store)],
    clients: ["0"],
    pageSize: 200,
    // No services filter — watchlist needs every trip the driver might be on.
    services: ["PICKING", "PICKING_DELIVERY", "DELIVERY"],
  };
  const r = await fetch(SWIFT_DASHBOARD_URL, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Dispatcher HTTP ${r.status}`);
  const data = await r.json();
  return data?.payload?.tasksByClientId?.["0"]?.trips || [];
}

// Generate a small inline PNG for the notification icon (the suite ships
// without raster icons today — see assets/icons/README.md). Cached after
// first call.
let _notifIconCache = null;
async function _getNotifIcon() {
  if (_notifIconCache) return _notifIconCache;
  try {
    const canvas = new OffscreenCanvas(64, 64);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0071CE";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "#FFC220";
    ctx.font = "bold 30px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("SF", 32, 34);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buf = await blob.arrayBuffer();
    // Base64 the bytes — chrome.notifications accepts data: URLs.
    let bin = "";
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    _notifIconCache = "data:image/png;base64," + btoa(bin);
  } catch (e) {
    console.warn("[SparkFraud watchlist] notif-icon gen failed:", e);
    // 1x1 transparent PNG fallback so notifications still fire.
    _notifIconCache = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  }
  return _notifIconCache;
}

async function _fireNotification(title, message) {
  try {
    const iconUrl = await _getNotifIcon();
    await chrome.notifications.create({
      type: "basic",
      iconUrl,
      title,
      message,
      priority: 2,
    });
  } catch (e) {
    console.warn("[SparkFraud watchlist] notification fire failed:", e);
  }
}

// Append a hit record to the persistent ring buffer (max N entries).
async function _appendHit(hit) {
  const cfg = await _getWatchlistConfig();
  const cutoff = Date.now() - WATCHLIST_TTL_MS;
  const cur = ((await chrome.storage.local.get(STORAGE_WATCHLIST_HITS_KEY))[STORAGE_WATCHLIST_HITS_KEY] || [])
    .filter(h => (h.hitAt || 0) >= cutoff);
  cur.push(hit);
  if (cur.length > cfg.max_hits_retained) cur.splice(0, cur.length - cfg.max_hits_retained);
  await chrome.storage.local.set({ [STORAGE_WATCHLIST_HITS_KEY]: cur });
}

// Auto-fetch order items for the matched trip's orders. Best-effort —
// failures are logged but don't block the notification.
async function _autoFetchItems(orderIds) {
  try {
    if (!orderIds.length) return null;
    // Reuse the driveOrderResolution handler internally — it handles the
    // fast/slow path + headers cache.
    const r = await handlers.driveOrderResolution({ orderIds });
    if (r?.ok && r.data?.payload) {
      // Group rows by orderNo for the hit record.
      const grouped = {};
      for (const row of r.data.payload) {
        const oid = row.orderNo;
        if (!grouped[oid]) grouped[oid] = [];
        grouped[oid].push({
          itemId: row.itemId,
          itemName: row.itemName,
          upc: row.upc,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          lineStatus: row.lineStatus,
        });
      }
      return grouped;
    }
  } catch (e) {
    console.warn("[SparkFraud watchlist] autofetch items failed:", e);
  }
  return null;
}

// The poll. Fires every periodInMinutes (~3min). Walks the watchlist,
// queries Dispatcher per unique store, matches by driver fullName, detects
// status transitions into the active set, fires notification + auto-fetches
// item details for matched trips.
async function pollWatchlist({ trigger = "alarm" } = {}) {
  const list = await _readWatchlist();
  if (!list.length) return { skipped: "empty-watchlist" };

  const cfg = await _getWatchlistConfig();
  const activeSet = new Set(cfg.active_statuses);

  // Single-store scope per the design: each entry has its own store.
  // Bucket entries by store so we make one Dispatcher call per unique store.
  const byStore = new Map();
  for (const entry of list) {
    if (!byStore.has(entry.store)) byStore.set(entry.store, []);
    byStore.get(entry.store).push(entry);
  }

  // Build headers once (auth is the slow part).
  const hdrRes = await _buildSwiftHeaders();
  if (!hdrRes.ok) {
    console.warn("[SparkFraud watchlist] auth not ready for poll:", hdrRes.reason);
    return { skipped: "auth-not-ready", reason: hdrRes.reason };
  }

  const state = await _readWatchlistState();
  const newHits = [];

  for (const [store, entries] of byStore) {
    let trips;
    try {
      trips = await _fetchDispatcherTrips(hdrRes.headers, store, cfg.dispatcher_window_minutes);
    } catch (e) {
      console.warn(`[SparkFraud watchlist] dispatcher fetch failed for store ${store}:`, e);
      continue;
    }

    // Tokenize every trip's driver fullName once for loose matching
    // (tolerant of middle names/initials on either side — see view.js
    // openDriverRecentOrders for the same logic).
    const tokensFor = (s) => String(s || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const tripsWithTokens = trips
      .map(t => {
        const d = t.driver || {};
        return { trip: t, tokens: tokensFor(`${d.firstName || ""} ${d.lastName || ""}`) };
      })
      .filter(x => x.tokens.length > 0);

    for (const entry of entries) {
      const key = _wlKey(entry);
      const prev = state[key] || {};
      const wantTokens = tokensFor(entry.driverName);
      if (!wantTokens.length) continue;
      const matchingTrips = tripsWithTokens
        .filter(x =>
          x.tokens[0] === wantTokens[0] &&
          x.tokens[x.tokens.length - 1] === wantTokens[wantTokens.length - 1]
        )
        .map(x => x.trip);
      if (!matchingTrips.length) {
        // Driver not currently on any trip at this store. Keep prev state.
        continue;
      }
      // Take the most recent active-status trip (or just the first one).
      const activeTrip = matchingTrips.find(t => activeSet.has(t.displayTripStatus))
                       ?? matchingTrips[0];
      const status = activeTrip.displayTripStatus || "";
      const tripId = activeTrip.batchId || activeTrip.tripId || activeTrip.id || "";
      const orderIds = (activeTrip.orders || []).map(o => o.orderId).filter(Boolean);

      // Update last-known state.
      state[key] = {
        lastStatus: status,
        lastSeenMs: Date.now(),
        lastTripId: tripId,
        lastOrderIds: orderIds,
      };

      // Fire a hit ONLY when status transitions INTO an active value
      // (avoids re-notifying for the same status on every 3-min poll).
      const isActive   = activeSet.has(status);
      const wasActive  = activeSet.has(prev.lastStatus);
      const tripChanged = tripId && tripId !== prev.lastTripId;
      if (isActive && (!wasActive || tripChanged)) {
        const itemsByOrder = await _autoFetchItems(orderIds);
        const hit = {
          driverName: entry.driverName,
          store: entry.store,
          status,
          tripId,
          orderIds,
          hitAt: Date.now(),
          trigger,
          itemsByOrder,
        };
        newHits.push(hit);
        await _appendHit(hit);
        await _fireNotification(
          `⚠ ${entry.driverName} — ${status}`,
          `Store ${entry.store} · ${orderIds.length} order(s)${orderIds.length ? ": " + orderIds.slice(0, 3).join(", ") + (orderIds.length > 3 ? "…" : "") : ""}`
        );
      }
    }
  }

  await chrome.storage.local.set({ [STORAGE_WATCHLIST_STATE_KEY]: state });
  return { newHits: newHits.length, watchlistSize: list.length };
}
