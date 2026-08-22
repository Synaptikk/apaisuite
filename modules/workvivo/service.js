// modules/workvivo/service.js
//
// Token-heartbeat service worker.
//
// Lifecycle:
//   1. register() (in module.js) creates a chrome.alarms entry that fires
//      every HEARTBEAT_PERIOD_MIN minutes
//   2. The alarm handler reads window.v2.chatConfig from any open
//      workvivo.walmart.com tab (MAIN-world via chrome.scripting) and
//      POSTs the token bundle to the user's configured QRCallBox endpoint
//   3. UI panel (view.js) calls service handlers to inspect status, manually
//      trigger a refresh, or update the endpoint+key configuration
//
// What lives in storage (host.storage.sync — small, follows the user):
//   workvivo.endpointUrl  — full URL of the QRCallBox token-heartbeat function
//   workvivo.apiKey       — user's heartbeat API key (issued in QRCallBox UI)
//   workvivo.lastStatus   — { at, ok, status, errorClass?, message? } of last attempt
//   workvivo.lastSuccess  — { at, storeNumber?, channelName? } of last 2xx
//
// What does NOT live in storage:
//   - The Sendbird access_token itself. The token has a server-side home in
//     Firestore via the QRCallBox endpoint; storing it on the extension side
//     would just be a stale duplicate that could leak via storage inspection.

import { ensureAlarm } from "../../shared/alarms.js";
import { readLiveTokenFromTab, hasWorkvivoTab, openWorkvivoTab, waitForLiveToken } from "./lib/extract.js";
import { postHeartbeat, fetchConnectionInfo }  from "./lib/qrcallbox.js";

const MODULE_ID            = "workvivo";
const ALARM_NAME           = "workvivo.heartbeat";
const HEARTBEAT_PERIOD_MIN = 60;        // every hour while extension is alive
const INITIAL_DELAY_MIN    = 1;         // first beat shortly after install/wake

// Default endpoint — the production QRCallBox custom domain. Using qrcallbox.com
// over qrwebaccdb.web.app or *.cloudfunctions.net specifically because Walmart's
// corp McAfee Web Gateway blocks *.cloudfunctions.net and *.web.app under
// "Store Block" but allows the custom domain through. Override via the
// extension's Advanced config only if you know why (dev/staging deploy).
const DEFAULT_ENDPOINT_URL = "https://qrcallbox.com/api/workvivo/token-heartbeat";

// Storage keys are the same strings used by view.js — keep in sync.
const KEY_ENDPOINT     = "endpointUrl";
const KEY_API_KEY      = "apiKey";
const KEY_LAST_STATUS  = "lastStatus";
const KEY_LAST_SUCCESS = "lastSuccess";

// Internal: shared with view.js via host.messaging broadcasts so the panel
// can update without polling. Type strings live here as constants to keep
// the contract searchable.
const BROADCAST_STATUS_CHANGED = "status-changed";

// ── Storage helpers (use host.storage via messaging would be circular here,
// so go direct — keys are still namespaced by the same convention)
const PFX = `${MODULE_ID}.`;

async function getConfig() {
  const got = await chrome.storage.sync.get([
    PFX + KEY_ENDPOINT,
    PFX + KEY_API_KEY,
  ]);
  const storedUrl = got[PFX + KEY_ENDPOINT] || "";
  return {
    endpointUrl:        storedUrl || DEFAULT_ENDPOINT_URL,
    endpointIsDefault:  !storedUrl,
    apiKey:             got[PFX + KEY_API_KEY] || "",
  };
}

async function setConfig({ endpointUrl, apiKey }) {
  // Empty endpointUrl OR matches the default = clear the override.
  // Avoids drift: if we change DEFAULT_ENDPOINT_URL later, users tracking the
  // default get the new value automatically instead of being pinned to the
  // old hardcoded string they happened to type.
  const trimmed = (endpointUrl ?? "").trim();
  const isDefault = !trimmed || trimmed === DEFAULT_ENDPOINT_URL;
  await chrome.storage.sync.set({
    [PFX + KEY_ENDPOINT]: isDefault ? "" : trimmed,
    [PFX + KEY_API_KEY]:  apiKey ?? "",
  });
}

async function recordStatus(status) {
  await chrome.storage.sync.set({ [PFX + KEY_LAST_STATUS]: status });
  if (status.ok) {
    await chrome.storage.sync.set({
      [PFX + KEY_LAST_SUCCESS]: {
        at:          status.at,
        storeNumber: status.body?.storeNumber ?? null,
        channelName: status.body?.channelName ?? null,
      },
    });
  }
  // Broadcast so the open view.js panel can refresh without polling.
  chrome.runtime.sendMessage({
    module: MODULE_ID,
    type:   BROADCAST_STATUS_CHANGED,
    status,
  }).catch(() => {}); // no listener if panel isn't mounted — harmless
}

async function getStoredStatus() {
  const got = await chrome.storage.sync.get([
    PFX + KEY_LAST_STATUS,
    PFX + KEY_LAST_SUCCESS,
  ]);
  return {
    lastStatus:  got[PFX + KEY_LAST_STATUS]  || null,
    lastSuccess: got[PFX + KEY_LAST_SUCCESS] || null,
  };
}

// ── Heartbeat core ────────────────────────────────────────────────────────

/**
 * Run one heartbeat attempt: read live token, POST to QRCallBox.
 * Records the result in storage and broadcasts to any open panel.
 *
 * Options:
 *   reason         — "alarm" | "manual" — recorded on the status row.
 *   openIfMissing  — if true and no Workvivo tab is currently open, create
 *                    one in the background and poll for the token to become
 *                    readable. Only the manual ("refresh-now") path passes
 *                    this — alarms must not silently open tabs.
 *
 * @returns {Promise<{ok:boolean, ...}>}
 */
async function runHeartbeat({ reason, openIfMissing } = { reason: "manual", openIfMissing: false }) {
  const at = Date.now();

  const { endpointUrl, apiKey } = await getConfig();
  if (!endpointUrl || !apiKey) {
    const status = {
      at, ok: false, reason,
      status: 0,
      errorClass: "CONFIG",
      message: "Endpoint URL or API key not configured — open the Workvivo panel to set them.",
    };
    await recordStatus(status);
    return status;
  }

  // Cheap pre-check: no Workvivo tab → no point doing the work, unless the
  // caller asked us to open one (manual "Send heartbeat now" path).
  let tabOpen = await hasWorkvivoTab();
  if (!tabOpen && openIfMissing) {
    await openWorkvivoTab();
    const live = await waitForLiveToken({ timeoutMs: 30_000, intervalMs: 1_000 });
    if (!live) {
      const status = {
        at, ok: false, reason,
        status: 0,
        errorClass: "NO_TOKEN",
        message: "Opened a Workvivo tab but the chat token didn't appear within 30s — you may need to sign in.",
      };
      await recordStatus(status);
      return status;
    }
    // Token already in hand from the wait loop — skip the second read below.
    return await postAndRecord({ at, reason, endpointUrl, apiKey, live });
  }
  if (!tabOpen) {
    const status = {
      at, ok: false, reason,
      status: 0,
      errorClass: "NO_TAB",
      message: "No workvivo.walmart.com tab open. Heartbeat will retry on next tick once you have one.",
    };
    await recordStatus(status);
    return status;
  }

  const live = await readLiveTokenFromTab();
  if (!live) {
    const status = {
      at, ok: false, reason,
      status: 0,
      errorClass: "NO_TOKEN",
      message: "Tab open but window.v2.chatConfig.access_token wasn't readable. Sign back into Workvivo chat.",
    };
    await recordStatus(status);
    return status;
  }

  return await postAndRecord({ at, reason, endpointUrl, apiKey, live });
}

async function postAndRecord({ at, reason, endpointUrl, apiKey, live }) {
  const post = await postHeartbeat({
    endpointUrl,
    apiKey,
    accessToken:    live.accessToken,
    workvivoUserId: live.workvivoUserId,
    appId:          live.appId,
  });

  const status = {
    at, ok: post.ok, reason,
    status:     post.status,
    errorClass: post.errorClass ?? null,
    message:    post.ok
      ? `Heartbeat OK${post.body?.storeNumber ? ` for store ${post.body.storeNumber}` : ""}.`
      : `Heartbeat failed (${post.errorClass}): ${typeof post.body === "string" ? post.body : (post.body?.error ?? JSON.stringify(post.body).slice(0, 200))}`,
    body:       post.body,
  };
  await recordStatus(status);
  return status;
}

// ── Alarm wiring (called from module.js register()) ───────────────────────
//
// Idempotent — see shared/alarms.js. The previous version called
// chrome.alarms.create() unconditionally on the belief that it "replaces any
// prior entry", which is true and is exactly the bug: replacing restarts the
// period. Installed from module.js::register() (shell page loads only), that
// meant opening the suite more often than HEARTBEAT_PERIOD_MIN kept the
// heartbeat permanently pending, and QRCallBox's Sendbird token went stale
// with no visible cause. ensureAlarm() still re-creates when the period
// constant changes, so editing HEARTBEAT_PERIOD_MIN takes effect next boot.
export async function installHeartbeatAlarm() {
  await ensureAlarm(ALARM_NAME, {
    delayInMinutes:  INITIAL_DELAY_MIN,
    periodInMinutes: HEARTBEAT_PERIOD_MIN,
  });
}

// How stale the last successful heartbeat must be before the alarm-driven
// tick spends the cost of opening a fresh workvivo.walmart.com tab. With a
// tab already open we just read the token (cheap). Without one, opening
// a new tab every hour would be noisy when the user is at their desk —
// the heartbeat just to refresh metadata isn't worth a tab spawn. After
// 12 hours of silence (overnight, weekend) the cached token in QRCallBox
// gets close to its lifetime; that's when we want to autonomously refresh.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

// Listener is registered at module top-level (in module.js) so it survives
// SW idle/wake. Body lives here.
export async function onAlarm(alarm) {
  if (alarm?.name !== ALARM_NAME) return;

  // Tab open → cheap read, just do it. Tab missing + fresh success → skip
  // silently (no point recording another NO_TAB status when we know last
  // success was recent). Tab missing + stale/no success → auto-open the
  // background tab so the keep-alive actually keeps alive.
  let openIfMissing = false;
  try {
    const tabOpen = await hasWorkvivoTab();
    if (!tabOpen) {
      const got = await chrome.storage.local.get(PFX + KEY_LAST_SUCCESS);
      const lastSuccess = got[PFX + KEY_LAST_SUCCESS];
      const ageMs = lastSuccess ? Date.now() - lastSuccess.at : Infinity;
      if (ageMs < STALE_AFTER_MS) {
        // Last success is fresh. Skip this tick silently — the panel's
        // "Last success" timestamp already tells the user we're healthy.
        return;
      }
      openIfMissing = true;
    }
  } catch (err) {
    console.warn("[workvivo] alarm staleness check failed:", err?.message);
    // Fall through with openIfMissing=false; safer to skip than spam tabs
    // if storage lookups are broken.
  }

  runHeartbeat({ reason: "alarm", openIfMissing }).catch((err) => {
    console.error("[workvivo] alarm heartbeat threw:", err);
  });
}

// ── SW handlers exposed via manifest.service.handlers ─────────────────────

export const handlers = {
  // UI: "what's our current state?"
  async "get-status"() {
    const stored = await getStoredStatus();
    const config = await getConfig();
    const tabOpen = await hasWorkvivoTab();
    return {
      ...stored,
      configured: !!(config.endpointUrl && config.apiKey),
      endpointUrl:       config.endpointUrl,
      endpointIsDefault: config.endpointIsDefault,
      apiKeyMasked:      maskKey(config.apiKey),
      tabOpen,
      heartbeatPeriodMin: HEARTBEAT_PERIOD_MIN,
    };
  },

  // UI: "save my endpoint + key"
  async "save-config"(msg) {
    const endpointUrl = String(msg.endpointUrl ?? "").trim();
    const apiKey      = String(msg.apiKey ?? "").trim();
    if (!apiKey) {
      return { ok: false, error: "API key is required." };
    }
    // Empty endpointUrl means "use default" — that's allowed (preferred, even).
    if (endpointUrl && !/^https:\/\/[^/]+\//i.test(endpointUrl)) {
      return { ok: false, error: "endpointUrl must be an https:// URL" };
    }
    await setConfig({ endpointUrl, apiKey });
    return { ok: true };
  },

  // UI: "test the connection now"
  async "refresh-now"() {
    const status = await runHeartbeat({ reason: "manual", openIfMissing: true });
    return { ok: true, status };
  },

  // UI: "stop using this and forget my key"
  async "clear-config"() {
    await chrome.storage.sync.remove([
      PFX + KEY_ENDPOINT,
      PFX + KEY_API_KEY,
      PFX + KEY_LAST_STATUS,
      PFX + KEY_LAST_SUCCESS,
    ]);
    return { ok: true };
  },

  // UI: fetch the "Your QRCallBox" panel card data — store, channel, scan
  // stats, recent activity. Read-only; safe to call on every panel mount
  // and to poll periodically while the panel is open.
  async "get-connection-info"() {
    const { endpointUrl, apiKey } = await getConfig();
    if (!endpointUrl || !apiKey) {
      return { ok: false, errorClass: "CONFIG", body: "not configured" };
    }
    return await fetchConnectionInfo({ endpointUrl, apiKey });
  },
};

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return k.slice(0, 4) + "…" + k.slice(-4);
}
