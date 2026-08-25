// modules/workvivo/lib/extract.js
//
// Reads the live Sendbird chat config from a workvivo.walmart.com tab using
// chrome.scripting.executeScript with `world: "MAIN"`.
//
// Why MAIN world: window.v2.chatConfig is set by Workvivo's own page JS. The
// extension's ISOLATED world content scripts can't see it (separate global
// object). Returning a plain serializable object from a MAIN-world function
// is the cleanest way to read it — no postMessage/CustomEvent dance.
//
// Why scripting from SW instead of a content script: we only need to read
// the value periodically (chrome.alarms-driven), not continuously. A content
// script is wasted bytes for periodic reads, and would need its own messaging
// hop to forward the value back to the SW.

import { registerSessionTab } from "../../../shared/tabSessions.js";

const WORKVIVO_URL_PATTERN = "https://workvivo.walmart.com/*";

/**
 * Find a Workvivo tab and read its chat config + user id from MAIN world.
 * @returns {Promise<{accessToken:string, workvivoUserId:string, appId:string,
 *                   tabId:number, capturedAt:number} | null>}
 */
export async function readLiveTokenFromTab() {
  const tabs = await chrome.tabs.query({ url: WORKVIVO_URL_PATTERN });
  if (!tabs.length) return null;

  // Prefer the most-recently-active workvivo.walmart.com tab — they're more
  // likely to have a fresh session than a long-idle background tab.
  const sorted = tabs
    .filter((t) => typeof t.id === "number")
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

  for (const tab of sorted) {
    const value = await readFromOneTab(tab.id);
    if (value?.accessToken && value?.workvivoUserId) {
      return { ...value, tabId: tab.id, capturedAt: Date.now() };
    }
  }
  return null;
}

async function readFromOneTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      // MAIN-world function — runs in the page's own JS context. Must be a
      // pure function: closures over outer variables won't survive
      // serialization to the page.
      func: () => {
        const v2 = /** @type any */ (globalThis).v2;
        const cfg = v2 && v2.chatConfig;
        if (!cfg || typeof cfg !== "object") return null;
        const accessToken = cfg.access_token || cfg.token || null;
        if (!accessToken) return null;
        return {
          accessToken,
          workvivoUserId: v2.id != null ? String(v2.id) : "",
          appId: cfg.app_id || null,
        };
      },
    });
    return results?.[0]?.result ?? null;
  } catch (err) {
    // executeScript fails if the tab navigated mid-call, the URL no longer
    // matches host_permissions, or the SW lost the scripting permission.
    // Surface to caller — it'll fall through to "no Workvivo tab open".
    console.debug("[workvivo extract] executeScript failed:", err?.message ?? err);
    return null;
  }
}

/**
 * @returns {Promise<boolean>} true if at least one workvivo.walmart.com tab
 * is currently open. Cheap (no script injection); use this to decide whether
 * to skip a heartbeat (no tab → nothing to read; the user re-opens Workvivo
 * on their next workday).
 */
export async function hasWorkvivoTab() {
  const tabs = await chrome.tabs.query({ url: WORKVIVO_URL_PATTERN });
  return tabs.length > 0;
}

/**
 * Open workvivo.walmart.com/chat in a background tab. Used by the manual
 * "Send heartbeat now" path when no Workvivo tab is already open.
 *
 * Background tab (active:false) so we don't yank focus away from whatever
 * the user was doing. The tab is left open after the heartbeat so future
 * periodic alarms can also read the token without re-opening — but it is
 * registered with the suite's idle reaper (shared/tabSessions.js), so "left
 * open" now means "until nothing has used it for a while" rather than "until
 * the user notices and closes it". The heartbeat is hourly and the reaper's
 * default grace is 15 minutes, so a heartbeat that opens its own tab gets it
 * swept before the next one — which is correct: each heartbeat can re-open.
 *
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function openWorkvivoTab() {
  const tab = await chrome.tabs.create({
    url:    "https://workvivo.walmart.com/chat",
    active: false,
  });
  await registerSessionTab("workvivo", tab.id);
  return tab;
}

/**
 * Poll for window.v2.chatConfig.access_token to become readable. Used after
 * openWorkvivoTab() to wait for the page's JS to finish bootstrapping the
 * chat SDK before we try to read the token. Returns the live token bundle
 * or null on timeout.
 *
 * If the user isn't authenticated, the page redirects to SSO and v2.chatConfig
 * never appears — we'll time out, and the caller surfaces that as the usual
 * NO_TOKEN status ("sign back into Workvivo chat").
 */
export async function waitForLiveToken({ timeoutMs = 30_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = await readLiveTokenFromTab();
    if (live?.accessToken && live?.workvivoUserId) return live;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
