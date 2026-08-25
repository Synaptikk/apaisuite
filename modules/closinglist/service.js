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

import { createAuth, SSO_SELECTORS } from "../../shared/auth.js";
import { findOrOpenTracked, closeIfOpened } from "../../shared/tabs.js";

const MODULE_ID       = "closinglist";
const IVR_ROOT_URL    = "https://ivrattcloud-prod.wal-mart.com/";
const IVR_HOST_RE     = /^https:\/\/ivrattcloud-prod\.wal-mart\.com\//;
const IVR_TAB_PATTERN = "https://ivrattcloud-prod.wal-mart.com/*";
const FLOW_KEY        = "closinglist.ivrFlowState";
const RESULT_KEY      = "closinglist.ivrLastResult";
const FLOW_TIMEOUT_MS = 180 * 1000;   // 3 min — accommodates MAC-error retries in ivr.js
const SSO_REDIRECT_TIMEOUT_MS = 45 * 1000;

const auth = createAuth(MODULE_ID);

// Single in-flight collector resolver. The UI's Collect button disables
// during collection, so concurrent calls aren't expected; if they occur the
// second simply replaces the first (the first will time out naturally).
let pendingIvrResolver = null;

// Returns { tab, opened }. `opened` matters because collectIvrAbsences
// NAVIGATES the tab (resetIvrTab) — so when the user already had IVR open we
// are borrowing their tab and must leave it where we found it, whereas a tab
// we opened is scratch space and gets closed when the collection ends.
async function findOrOpenIvrTab() {
  return findOrOpenTracked(IVR_ROOT_URL, { match: IVR_TAB_PATTERN });
}

async function resetIvrTab(tabId) {
  // Navigate to root so the content script starts from a known state.
  await chrome.tabs.update(tabId, { url: IVR_ROOT_URL, active: false });
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
      // Landed back on IVR after SSO. The user's `resetIvrTab` navigation
      // happened pre-SSO, so the post-SSO landing may be the IVR home page,
      // not the menu. Re-navigate to ensure the content script sees the
      // expected starting state.
      await chrome.tabs.update(tabId, { url: IVR_ROOT_URL, active: false });
      await waitForTabLoad(tabId, 15_000);
      return;
    }
  }
  // Didn't complete in time — fall through; the collection promise will
  // time out and report the "needs sign-in" error to the user.
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

  let state = null;
  try {
    state = await findOrOpenIvrTab();
    await resetIvrTab(state.tab.id);
    // Full-automation: if the tab redirected to SSO, auto-click + wait for
    // round-trip back to IVR before the content-script flow takes over.
    await ensureIvrAuth(state.tab.id);
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
  } finally {
    // Covers the timeout path too: resultPromise RESOLVES on timeout rather
    // than rejecting, so a stalled collection returned through the success
    // branch above and left its tab behind.
    await closeIfOpened(state);
  }
}

export const handlers = {
  async "collect-ivr-absences"(_msg) {
    return collectIvrAbsences();
  },

  async "get-last-ivr-result"(_msg) {
    const r = await chrome.storage.local.get(RESULT_KEY);
    return r[RESULT_KEY] || null;
  },

  // Inbound from the IVR content script when it finishes scraping. The
  // suite-wide SW dispatcher routes this here based on (module, type). We
  // hand the payload to the pending collector promise.
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
    // Always respond OK so the content script's sendMessage promise resolves
    // cleanly. (It doesn't await the response, but a structured response
    // keeps DevTools quiet.)
    return { ok: true };
  },
};
