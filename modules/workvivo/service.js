// modules/workvivo/service.js
//
// Token-heartbeat service worker.
//
// Lifecycle:
//   1. module.js installs a chrome.alarms entry at SW top level that fires
//      every HEARTBEAT_PERIOD_MIN minutes.
//   2. The alarm handler reads window.v2.chatConfig from an open
//      workvivo.walmart.com tab (MAIN-world via chrome.scripting) and POSTs
//      the token bundle to QRCallBox. With no tab open it opens one in the
//      background when the last success is stale or the server says the
//      token is dead, so the keep-alive keeps alive without anyone at the
//      desk.
//   3. Failures schedule a one-shot retry alarm (10 min, up to 3 times)
//      instead of waiting an hour; a signed-out Workvivo surfaces as an OS
//      notification after two consecutive misses.
//   4. QRCallBox can push "workvivo-refresh" (Web Push) the moment Sendbird
//      rejects the token at scan time; module.js routes that here via
//      manifest.service.onPush and we run an immediate heartbeat.
//   5. The panel (view.js) calls the handlers below to inspect status, run
//      a heartbeat, pick the store channel, and manage the API key.
//
// Storage:
//   sync  (follows the user)
//     workvivo.endpointUrl  — override of the QRCallBox heartbeat URL ("" = default)
//     workvivo.apiKey       — the user's heartbeat API key
//     workvivo.lastStatus   — { at, ok, reason, status, errorClass?, message? }
//     workvivo.lastSuccess  — { at, storeNumber?, channelName? }
//   local (this machine)
//     workvivo.server       — { health, channels, fetchedAt } from the last
//                             heartbeat / set-channel response
//     workvivo.retry        — { count, lastFailureAt }
//     workvivo.nudge        — { noTokenStreak, lastNotifiedAt }
//
// The Sendbird access_token itself is never stored on the extension side.
// QRCallBox's Firestore doc is the single source of truth; the extension is
// a courier.

import { ensureAlarm } from "../../shared/alarms.js";
import { withSessionTabs } from "../../shared/tabSessions.js";
import { readLiveTokenFromTab, hasWorkvivoTab, openWorkvivoTab, waitForLiveToken } from "./lib/extract.js";
import { postHeartbeat, fetchConnectionInfo, postServerTest, postSetChannel } from "./lib/qrcallbox.js";

const MODULE_ID            = "workvivo";
export const ALARM_NAME    = "workvivo.heartbeat";
export const RETRY_ALARM   = "workvivo.retry";
const HEARTBEAT_PERIOD_MIN = 60;        // every hour while the browser is alive
const INITIAL_DELAY_MIN    = 1;         // first beat shortly after install/wake
const RETRY_DELAY_MIN      = 10;
const MAX_RETRIES          = 3;

// How stale the last success may be before an alarm tick, finding no
// Workvivo tab, spends the cost of opening one in the background. Six hours
// keeps a desk that closed Workvivo at 5pm refreshed overnight without a
// tab spawn every hour of the working day.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// OS notification when Workvivo is signed out: after this many consecutive
// automatic NO_TOKEN results, at most once per NUDGE_MIN_GAP_MS.
const NUDGE_AFTER_STREAK    = 2;
const NUDGE_MIN_GAP_MS      = 12 * 60 * 60 * 1000;
const NUDGE_NOTIFICATION_ID = "workvivo.signin-nudge";

// Default endpoint — the production QRCallBox custom domain. qrcallbox.com
// rather than *.web.app / *.cloudfunctions.net because Walmart's corp web
// gateway blocks those under "Store Block" but allows the custom domain.
const DEFAULT_ENDPOINT_URL = "https://qrcallbox.com/api/workvivo/token-heartbeat";

const PFX = `${MODULE_ID}.`;
const KEY_ENDPOINT     = "endpointUrl";
const KEY_API_KEY      = "apiKey";
const KEY_LAST_STATUS  = "lastStatus";
const KEY_LAST_SUCCESS = "lastSuccess";
const KEY_SERVER       = "server";
const KEY_RETRY        = "retry";
const KEY_NUDGE        = "nudge";

// Broadcast to the open panel so it repaints without polling.
const BROADCAST_STATUS_CHANGED = "status-changed";

// ── Storage helpers ────────────────────────────────────────────────────────

async function getConfig() {
  const got = await chrome.storage.sync.get([PFX + KEY_ENDPOINT, PFX + KEY_API_KEY]);
  const storedUrl = got[PFX + KEY_ENDPOINT] || "";
  return {
    endpointUrl:       storedUrl || DEFAULT_ENDPOINT_URL,
    endpointIsDefault: !storedUrl,
    apiKey:            got[PFX + KEY_API_KEY] || "",
  };
}

async function setConfig({ endpointUrl, apiKey }) {
  // Empty or default endpointUrl clears the override so users tracking the
  // default follow it if DEFAULT_ENDPOINT_URL ever changes.
  const trimmed = (endpointUrl ?? "").trim();
  const isDefault = !trimmed || trimmed === DEFAULT_ENDPOINT_URL;
  await chrome.storage.sync.set({
    [PFX + KEY_ENDPOINT]: isDefault ? "" : trimmed,
    [PFX + KEY_API_KEY]:  apiKey ?? "",
  });
}

async function getLocal(key, fallback) {
  try {
    const got = await chrome.storage.local.get(PFX + key);
    return got[PFX + key] ?? fallback;
  } catch {
    return fallback;
  }
}

async function setLocal(key, value) {
  await chrome.storage.local.set({ [PFX + key]: value });
}

// shared/push.js keeps the Web Push installation id here; sending it with
// the heartbeat lets QRCallBox push a refresh straight to this browser.
async function getInstallationId() {
  try {
    const got = await chrome.storage.local.get("shell.installationId");
    return typeof got["shell.installationId"] === "string" ? got["shell.installationId"] : null;
  } catch {
    return null;
  }
}

function broadcast(status) {
  chrome.runtime.sendMessage({ module: MODULE_ID, type: BROADCAST_STATUS_CHANGED, status })
    .catch(() => {}); // no listener when the panel isn't mounted
}

async function recordStatus(status) {
  // Keep sync rows small: the response body (channel list, health) lives in
  // local storage under `server`; sync only gets the headline.
  const { body, ...slim } = status;
  slim.storeNumber = body?.storeNumber ?? slim.storeNumber ?? null;
  slim.channelName = body?.channelName ?? slim.channelName ?? null;
  await chrome.storage.sync.set({ [PFX + KEY_LAST_STATUS]: slim });
  if (status.ok) {
    await chrome.storage.sync.set({
      [PFX + KEY_LAST_SUCCESS]: {
        at:          status.at,
        storeNumber: slim.storeNumber,
        channelName: slim.channelName,
      },
    });
  }
  broadcast(slim);
}

async function getStoredStatus() {
  const got = await chrome.storage.sync.get([PFX + KEY_LAST_STATUS, PFX + KEY_LAST_SUCCESS]);
  return {
    lastStatus:  got[PFX + KEY_LAST_STATUS]  || null,
    lastSuccess: got[PFX + KEY_LAST_SUCCESS] || null,
  };
}

async function rememberServer({ health, channels }) {
  const prev = await getLocal(KEY_SERVER, {});
  await setLocal(KEY_SERVER, {
    health:    health ?? prev.health ?? null,
    channels:  Array.isArray(channels) ? channels : (prev.channels ?? []),
    fetchedAt: Date.now(),
  });
}

// ── Heartbeat core ─────────────────────────────────────────────────────────

/**
 * Run one heartbeat attempt: read live token, POST to QRCallBox, record.
 *
 *   reason        — "alarm" | "retry" | "push" | "manual"
 *   openIfMissing — with no Workvivo tab open, create one in the background
 *                   and wait for the token. Alarms pass this only when the
 *                   last success is stale or the server says the token died.
 */
async function runHeartbeat(opts) {
  return withSessionTabs(MODULE_ID, () => runHeartbeatImpl(opts));
}

async function runHeartbeatImpl({ reason = "manual", openIfMissing = false } = {}) {
  const at = Date.now();
  const automatic = reason !== "manual";

  const { endpointUrl, apiKey } = await getConfig();
  if (!endpointUrl || !apiKey) {
    const status = {
      at, ok: false, reason, status: 0, errorClass: "CONFIG",
      message: "API key not saved yet — paste it in step 1.",
    };
    await recordStatus(status);
    return status;
  }

  let live = null;
  const tabOpen = await hasWorkvivoTab();
  if (tabOpen) {
    live = await readLiveTokenFromTab();
  } else if (openIfMissing) {
    await openWorkvivoTab();
    live = await waitForLiveToken({ timeoutMs: 30_000, intervalMs: 1_000 });
  } else {
    const status = {
      at, ok: false, reason, status: 0, errorClass: "NO_TAB",
      message: "No workvivo.walmart.com tab open. Retrying on the next tick.",
    };
    await recordStatus(status);
    return status;
  }

  if (!live) {
    const status = {
      at, ok: false, reason, status: 0, errorClass: "NO_TOKEN",
      message: tabOpen
        ? "Workvivo is open but the chat token isn't readable. Sign back into Workvivo chat."
        : "Opened Workvivo in the background but no chat token appeared in 30s. Sign into Workvivo in this browser.",
    };
    await recordStatus(status);
    await afterFailure(status, automatic);
    return status;
  }

  const post = await postHeartbeat({
    endpointUrl, apiKey,
    accessToken:    live.accessToken,
    workvivoUserId: live.workvivoUserId,
    appId:          live.appId,
    installationId: await getInstallationId(),
  });

  const status = {
    at, ok: post.ok, reason,
    status:     post.status,
    errorClass: post.errorClass ?? null,
    message:    post.ok
      ? describeSuccess(post.body)
      : `QRCallBox refused the token (${post.errorClass}): ${typeof post.body === "string" ? post.body : (post.body?.error ?? JSON.stringify(post.body).slice(0, 200))}`,
    body:       post.body,
  };

  if (post.ok) {
    await rememberServer({ health: post.body?.health ?? null, channels: post.body?.channels });
    await setLocal(KEY_RETRY, { count: 0, lastFailureAt: null });
    await setLocal(KEY_NUDGE, { ...(await getLocal(KEY_NUDGE, {})), noTokenStreak: 0 });
    await chrome.alarms.clear(RETRY_ALARM).catch(() => {});
    await recordStatus(status);
    // The user has clearly signed in; retire any pending nudge.
    try { chrome.notifications.clear(NUDGE_NOTIFICATION_ID, () => void chrome.runtime.lastError); } catch {}
  } else {
    await recordStatus(status);
    await afterFailure(status, automatic);
  }
  return status;
}

function describeSuccess(body) {
  const store = body?.storeNumber ? `store ${body.storeNumber}` : "your store";
  const st = body?.health?.status;
  if (st === "needs_channel")   return `Token delivered for ${store}. Pick the channel in step 3.`;
  if (st === "needs_reauth")    return `Token delivered for ${store}; the server last saw it rejected and will retry on the next scan.`;
  if (st === "validation_warn") return `Token delivered for ${store}; Sendbird preflight failed, the server will still try.`;
  return `Token delivered for ${store}${body?.channelName ? ` → ${body.channelName}` : ""}.`;
}

/**
 * Failure follow-up: schedule a short retry for transient classes, and
 * nudge the user with an OS notification when Workvivo looks signed out.
 * Manual attempts never schedule retries or notifications; the person is
 * looking at the panel.
 */
async function afterFailure(status, automatic) {
  if (!automatic) return;

  const retryable = new Set(["NO_TOKEN", "NETWORK", "TIMEOUT", "SERVER"]);
  if (retryable.has(status.errorClass)) {
    const retry = await getLocal(KEY_RETRY, { count: 0 });
    if ((retry.count ?? 0) < MAX_RETRIES) {
      await setLocal(KEY_RETRY, { count: (retry.count ?? 0) + 1, lastFailureAt: status.at });
      await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MIN });
    }
  }

  if (status.errorClass === "NO_TOKEN") {
    const nudge = await getLocal(KEY_NUDGE, { noTokenStreak: 0, lastNotifiedAt: 0 });
    const streak = (nudge.noTokenStreak ?? 0) + 1;
    const due = streak >= NUDGE_AFTER_STREAK
      && Date.now() - (nudge.lastNotifiedAt ?? 0) > NUDGE_MIN_GAP_MS;
    await setLocal(KEY_NUDGE, {
      noTokenStreak:  streak,
      lastNotifiedAt: due ? Date.now() : (nudge.lastNotifiedAt ?? 0),
    });
    if (due) showSignInNudge();
  }
}

function showSignInNudge() {
  try {
    chrome.notifications.create(NUDGE_NOTIFICATION_ID, {
      type:     "basic",
      iconUrl:  chrome.runtime.getURL("assets/icons/suite-128.png"),
      title:    "QRCallBox needs Workvivo",
      message:  "Sign in to workvivo.walmart.com in this browser so QRCallBox can keep posting scan alerts to your store's chat.",
      priority: 1,
    }, () => void chrome.runtime.lastError);
  } catch (e) {
    console.warn("[workvivo] notification failed:", e?.message ?? e);
  }
}

/** Registered at SW top level by module.js. */
export function onNotificationClicked(notificationId) {
  if (notificationId !== NUDGE_NOTIFICATION_ID) return;
  try { chrome.notifications.clear(notificationId, () => void chrome.runtime.lastError); } catch {}
  chrome.tabs.create({ url: "https://workvivo.walmart.com/chat" }).catch(() => {});
}

// ── Alarm wiring ───────────────────────────────────────────────────────────

// Idempotent (shared/alarms.js): re-creating an existing alarm would restart
// its period on every SW boot and the heartbeat could stay pending forever.
export async function installHeartbeatAlarm() {
  await ensureAlarm(ALARM_NAME, {
    delayInMinutes:  INITIAL_DELAY_MIN,
    periodInMinutes: HEARTBEAT_PERIOD_MIN,
  });
}

/**
 * Should an automatic tick with no Workvivo tab open one? Yes when the last
 * success is stale, or when the server's last word on this token was "dead"
 * after our last success.
 */
async function shouldOpenTab() {
  const { lastSuccess } = await getStoredStatus();
  const ageMs = lastSuccess?.at ? Date.now() - lastSuccess.at : Infinity;
  if (ageMs >= STALE_AFTER_MS) return true;
  const server = await getLocal(KEY_SERVER, {});
  const h = server?.health;
  if (h?.status === "needs_reauth") return true;
  if (h?.tokenDiedAtMs && h.tokenDiedAtMs > (lastSuccess?.at ?? 0)) return true;
  return false;
}

// Listener is registered at module top level (in module.js). Body lives here.
export async function onAlarm(alarm) {
  if (alarm?.name === RETRY_ALARM) {
    runHeartbeat({ reason: "retry", openIfMissing: true }).catch((err) => {
      console.error("[workvivo] retry heartbeat threw:", err);
    });
    return;
  }
  if (alarm?.name !== ALARM_NAME) return;

  let openIfMissing = false;
  try {
    if (!(await hasWorkvivoTab())) {
      if (!(await shouldOpenTab())) return;   // fresh enough: skip silently
      openIfMissing = true;
    }
  } catch (err) {
    console.warn("[workvivo] alarm staleness check failed:", err?.message);
  }
  runHeartbeat({ reason: "alarm", openIfMissing }).catch((err) => {
    console.error("[workvivo] alarm heartbeat threw:", err);
  });
}

/**
 * Web Push from QRCallBox (functions/src/http/workvivo/push-refresh.js):
 * Sendbird rejected our token at scan time, courier a fresh one right now.
 * Routed here by service_worker.js via manifest.service.onPush.
 */
export async function onPush(payload) {
  if (payload?.type !== "workvivo-refresh") return false;
  // Chrome requires a user-visible notification per push; make it useful.
  try {
    await self.registration.showNotification("QRCallBox is refreshing your Workvivo link", {
      body: `The server's copy of your chat token stopped working${payload.storeNumber ? ` for store ${payload.storeNumber}` : ""}. Sending a fresh one now.`,
      icon: chrome.runtime.getURL("assets/icons/suite-128.png"),
      tag:  "workvivo-refresh",
      silent: true,
    });
  } catch { /* best-effort */ }
  await runHeartbeat({ reason: "push", openIfMissing: true }).catch((err) => {
    console.error("[workvivo] push heartbeat threw:", err);
  });
  return true;
}

// ── SW handlers exposed via manifest.service.handlers ──────────────────────

export const handlers = {
  async "get-status"() {
    const [stored, config, tabOpen, server, alarm, retry, installationId] = await Promise.all([
      getStoredStatus(), getConfig(), hasWorkvivoTab(),
      getLocal(KEY_SERVER, {}), chrome.alarms.get(ALARM_NAME).catch(() => null),
      getLocal(KEY_RETRY, {}), getInstallationId(),
    ]);
    return {
      ...stored,
      configured:         !!(config.endpointUrl && config.apiKey),
      endpointUrl:        config.endpointUrl,
      endpointIsDefault:  config.endpointIsDefault,
      apiKeyMasked:       maskKey(config.apiKey),
      tabOpen,
      heartbeatPeriodMin: HEARTBEAT_PERIOD_MIN,
      nextHeartbeatAt:    alarm?.scheduledTime ?? null,
      retryCount:         retry?.count ?? 0,
      server:             server ?? {},
      pushLinked:         !!(server?.health?.pushLinked) && !!installationId,
    };
  },

  async "save-config"(msg) {
    const endpointUrl = String(msg.endpointUrl ?? "").trim();
    const apiKey      = String(msg.apiKey ?? "").trim();
    if (!apiKey) return { ok: false, error: "API key is required." };
    if (endpointUrl && !/^https:\/\/[^/]+\//i.test(endpointUrl)) {
      return { ok: false, error: "endpointUrl must be an https:// URL" };
    }
    await setConfig({ endpointUrl, apiKey });
    return { ok: true };
  },

  async "refresh-now"() {
    const status = await runHeartbeat({ reason: "manual", openIfMissing: true });
    return { ok: true, status };
  },

  async "clear-config"() {
    await chrome.storage.sync.remove([
      PFX + KEY_ENDPOINT, PFX + KEY_API_KEY, PFX + KEY_LAST_STATUS, PFX + KEY_LAST_SUCCESS,
    ]);
    await chrome.storage.local.remove([PFX + KEY_SERVER, PFX + KEY_RETRY, PFX + KEY_NUDGE]);
    await chrome.alarms.clear(RETRY_ALARM).catch(() => {});
    broadcast(null);
    return { ok: true };
  },

  // Focus an existing Workvivo tab or open chat in the foreground.
  async "open-workvivo"() {
    const tabs = await chrome.tabs.query({ url: "https://workvivo.walmart.com/*" });
    if (tabs[0]?.id != null) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) {
        await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
      }
    } else {
      await chrome.tabs.create({ url: "https://workvivo.walmart.com/chat", active: true });
    }
    return { ok: true };
  },

  // Pick the store channel from the list the last heartbeat returned.
  async "set-channel"(msg) {
    const { endpointUrl, apiKey } = await getConfig();
    if (!endpointUrl || !apiKey) return { ok: false, errorClass: "CONFIG", body: "not configured" };
    const channelUrl = String(msg?.channelUrl ?? "").trim();
    if (!channelUrl) return { ok: false, errorClass: "VALIDATION", body: "no channel chosen" };
    const r = await postSetChannel({ endpointUrl, apiKey, channelUrl });
    if (r.ok) {
      await rememberServer({ health: r.body?.health, channels: r.body?.channels });
      const { lastStatus } = await getStoredStatus();
      if (lastStatus) {
        const next = { ...lastStatus, channelName: r.body?.channelName ?? lastStatus.channelName };
        await chrome.storage.sync.set({ [PFX + KEY_LAST_STATUS]: next });
        broadcast(next);
      } else {
        broadcast(null);
      }
    } else if (Array.isArray(r.body?.channels)) {
      await rememberServer({ channels: r.body.channels });
    }
    return r;
  },

  async "get-connection-info"() {
    const { endpointUrl, apiKey } = await getConfig();
    if (!endpointUrl || !apiKey) return { ok: false, errorClass: "CONFIG", body: "not configured" };
    const r = await fetchConnectionInfo({ endpointUrl, apiKey });
    if (r.ok && r.body?.health) await rememberServer({ health: r.body.health });
    return r;
  },

  // "Prove the SERVER can post, not just me." Sends nothing but the API
  // key; the server posts with the token this module couriered earlier.
  // No status recording: lastStatus describes the heartbeat only.
  async "server-test-post"(msg) {
    const { endpointUrl, apiKey } = await getConfig();
    if (!endpointUrl || !apiKey) return { ok: false, errorClass: "CONFIG", body: "not configured" };
    return await postServerTest({
      endpointUrl, apiKey,
      note: typeof msg?.note === "string" ? msg.note : undefined,
    });
  },
};

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return k.slice(0, 4) + "…" + k.slice(-4);
}
