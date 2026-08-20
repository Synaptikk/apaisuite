// modules/metricshot/lib/sendbird.js
//
// Posts screenshots + text to a Workvivo/Sendbird group channel via the
// Sendbird Platform REST API.
//
// ── Auth flow (verified 2026-07-28 via live CDP; see UPLOAD_PLAN.md) ────────
// Workvivo wraps Sendbird for chat. We get credentials the SAME way the app
// itself does — no scraping, no fragile network sniffer:
//   1. GET /api/chat/config  (Laravel session cookie + X-XSRF-TOKEN header)
//        → { app_id, access_token }
//   2. Open a Sendbird WebSocket with the access_token; the LOGI handshake
//        returns a short-lived `key` (the session key).
//   3. Call api-{appid}.sendbird.com/v3 with that key as `Session-key`.
//
// NOTE: the access_token is NOT itself a valid session key (Sendbird returns
// 400303 "Session key is invalid") — it must be exchanged via step 2.
//
// Header recipe proven to return 200:
//   Session-key, App-Id, Content-Type: application/json; charset=utf-8,
//   SendBird: JS,web,4.22.0,{appId}, SB-User-Agent: JS/c4.22.0///oweb
//
// Channel targeting:
//   - "@me" / "@self" / "(me)"  → find-or-create the 1-member self channel
//   - anything else             → match a joined channel by name
//
// We run the REST worker in the workvivo tab's MAIN world so it inherits the
// page's cookies/CORS context. chrome.scripting.executeScript({ func }) only
// serializes the top-level function body — helpers must be inlined. Every
// IN_PAGE_* function below is fully self-contained.

import { postImageViaWorkvivoUI } from "./workvivo_upload.js";

const WORKVIVO_URL = "https://workvivo.walmart.com/chat";

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a text-only message to a channel.
 * @returns {Promise<{ok:boolean, path:"rest"|"none", channelUrl?:string, messageId?:string, error?:string, errorClass?:string}>}
 */
export async function postTextToWorkvivo({ channelName, text }) {
  if (!text || typeof text !== "string") return { ok: false, path: "none", errorClass: "INPUT", error: "missing text" };
  if (!channelName) return { ok: false, path: "none", errorClass: "INPUT", error: "missing channelName" };

  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, path: "none", errorClass: tabRes.errorClass, error: tabRes.error, debug: tabRes.debug };
  const { tabId, openedFresh } = tabRes;
  try {
    const r = await _runInTab(tabId, IN_PAGE_SB, [{ action: "text", channelName, text }]);
    return { ...(r || { ok: false, errorClass: "REST_FAIL", error: "no result" }), path: "rest" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

/**
 * Post a PNG screenshot (base64) to a channel, with optional caption.
 *
 * IMPORTANT: Sendbird's REST API blocks file messages for this app
 * (400108 "File-messages via SDK are disabled."). So images can NOT go via
 * REST — they must be posted through Workvivo's own UI composer, driven by CDP
 * (see lib/workvivo_upload.js). We therefore:
 *   1. Resolve the channelName → channel_url via the working REST path.
 *   2. Hand off to postImageViaWorkvivoUI, which opens the channel, sets the
 *      file on #chat-file-attach via DOM.setFileInputFiles, and clicks Send.
 * The caption (if any) is posted as a separate REST text message, which DOES
 * work — keeping text + image both delivered.
 *
 * @returns {Promise<{ok:boolean, path:"ui"|"none", channelUrl?:string, error?:string, errorClass?:string}>}
 */
export async function postScreenshotToWorkvivo({ channelName, pngBase64, fileName, caption, onStep }) {
  const step = (name, extra) => { try { onStep?.(name, extra); } catch { /* ignore */ } };
  if (!pngBase64) return { ok: false, path: "none", errorClass: "INPUT", error: "missing pngBase64" };
  if (!channelName) return { ok: false, path: "none", errorClass: "INPUT", error: "missing channelName" };

  // 1. Resolve channel_url via REST (opens + closes its own tab).
  step("resolve-channel");
  const resolved = await resolveChannel(channelName);
  if (!resolved.ok) {
    return { ok: false, path: "none", errorClass: resolved.errorClass || "REST_FAIL", error: resolved.error };
  }
  step("channel-resolved", { channelUrl: resolved.channelUrl });

  // 2. Post the image through Workvivo's UI composer (CDP-driven).
  step("ui-upload");
  const up = await postImageViaWorkvivoUI({
    channelUrl: resolved.channelUrl,
    pngBase64,
    fileName,
    onStep: (name, extra) => step(`ui:${name}`, extra),
  });
  step("ui-upload-done", { ok: !!up.ok, errorClass: up.errorClass });

  // 3. Best-effort caption as a separate text message (REST text works fine).
  if (up.ok && caption) {
    step("caption");
    await postTextToWorkvivo({ channelName, text: String(caption) }).catch(() => {});
  }

  return { ...up, path: up.ok ? "ui" : (up.path || "none"), channelUrl: resolved.channelUrl };
}

/**
 * Resolve a channelName to a channel URL without posting. Used by the UI's
 * "Validate destination" action and as a capture pre-flight.
 */
export async function resolveChannel(channelName) {
  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, errorClass: tabRes.errorClass, error: tabRes.error };
  const { tabId, openedFresh } = tabRes;
  try {
    const r = await _runInTab(tabId, IN_PAGE_SB, [{ action: "resolve", channelName }]);
    return r || { ok: false, errorClass: "REST_FAIL", error: "no result" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

/**
 * Diagnostic: report the signed-in / chat-config state of a live workvivo tab.
 * Surfaced by the UI's troubleshoot action.
 */
export async function introspectSdk() {
  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, errorClass: tabRes.errorClass, error: tabRes.error, debug: tabRes.debug };
  const { tabId, openedFresh } = tabRes;
  try {
    const r = await _runInTab(tabId, IN_PAGE_INTROSPECT, []);
    return { ok: true, ...(r || {}) };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

// ── Tab lifecycle ────────────────────────────────────────────────────────────

/**
 * Always open our OWN fresh background workvivo tab, wait until it's signed in
 * (window.v2.id + chatConfig present), and return it with openedFresh:true so
 * the caller (_closeIfOwn) closes it after posting. We never reuse the user's
 * tab (avoids hijacking their session).
 */
async function _ensureWorkvivoTab({ waitMs = 30_000, onStep } = {}) {
  const step = (name, extra) => { try { onStep?.(name, extra); } catch { /* ignore */ } };
  step("tab-create");
  const tab = await chrome.tabs.create({ url: WORKVIVO_URL, active: false })
    .catch((e) => ({ __err: String(e?.message ?? e) }));
  if (!tab || tab.__err || !tab.id) {
    return { ok: false, errorClass: "NO_TAB", error: `could not open workvivo tab: ${tab?.__err || "unknown"}` };
  }
  step("tab-opened", { tabId: tab.id });

  // Poll until the page is signed in and chat config is present. The SDK
  // boots within ~1-2s of load, but background tabs are throttled so give it a
  // hidden grace period, then briefly foreground to force boot if needed.
  step("creds-wait-hidden");
  let creds = await _waitForCreds(tab.id, Math.min(waitMs, 8_000));
  if (!creds) {
    step("creds-wait-foreground");
    const prevActive = await _currentActiveTab();
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    try {
      creds = await _waitForCreds(tab.id, Math.max(waitMs - 8_000, 10_000));
    } finally {
      if (prevActive?.id && prevActive.id !== tab.id) {
        await chrome.tabs.update(prevActive.id, { active: true }).catch(() => {});
      }
    }
  }
  if (!creds) {
    const probe = await _runInTab(tab.id, IN_PAGE_INTROSPECT, []).catch(() => null);
    step("creds-not-found", { probe });
    return {
      ok: false, errorClass: "NO_SESSION",
      error: `opened workvivo tab but not signed in / chat config unavailable within ${Math.round(waitMs / 1000)}s — sign in to Workvivo, then retry`,
      debug: probe,
    };
  }
  step("creds-ready", { userId: creds.userId, appId: creds.appId });
  return { ok: true, tabId: tab.id, openedFresh: true };
}

async function _waitForCreds(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null; // tab gone
    const r = await _runInTab(tabId, IN_PAGE_READ_CREDS, []).catch(() => null);
    if (r && r.appId && r.userId) return r;
    await _delay(1000);
  }
  return null;
}

async function _currentActiveTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t || null;
  } catch { return null; }
}

async function _closeIfOwn(tabId, openedFresh) {
  if (!openedFresh) return;
  try { await chrome.tabs.remove(tabId); } catch (_) { /* already gone */ }
}

function _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _runInTab(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      args,
      func,
    });
    return results?.[0]?.result ?? null;
  } catch (e) {
    return { ok: false, errorClass: "SCRIPT_FAIL", error: String(e?.message ?? e) };
  }
}

// ── In-page functions (MAIN world, self-contained, PURE) ─────────────────────

/** Read creds from Workvivo's own config (no sniffer). Returns null until the
 *  page is signed in and /api/chat/config is reachable. */
function IN_PAGE_READ_CREDS() {
  const w = /** @type any */ (globalThis);
  const userId = w.v2 && w.v2.id != null ? String(w.v2.id) : null;
  const cfg = w.v2 && w.v2.chatConfig;
  const appId = (cfg && cfg.app_id) || null;
  if (!userId || !appId) return null;
  return { appId, userId, signedIn: true };
}

/** Diagnostic snapshot of page + config state. */
function IN_PAGE_INTROSPECT() {
  const w = /** @type any */ (globalThis);
  const cfg = w.v2 && w.v2.chatConfig;
  return {
    signedIn: !!(w.v2 && w.v2.id),
    appId: (cfg && cfg.app_id) || null,
    userId: w.v2 && w.v2.id != null ? String(w.v2.id) : null,
    hasChatConfig: !!cfg,
    href: location.href,
  };
}

/**
 * The single in-page REST worker. Serialized into the workvivo tab's MAIN
 * world by chrome.scripting. Dispatches on `arg.action` so all the shared
 * channel-resolution + auth logic lives in ONE self-contained function
 * (DRY) without needing eval/new Function — which MV3 service-worker CSP
 * forbids anyway. All helpers are nested; nothing outside this function is
 * referenced.
 *
 * actions: "resolve" | "text"
 */
async function IN_PAGE_SB(arg) {
  const w = /** @type any */ (globalThis);

  // ── Credentials: fetch from Workvivo's own config, then mint a Sendbird
  //    session key via the WS handshake. No scraping/sniffer needed.
  //    (Verified 2026-07-28 via CDP: /api/chat/config returns
  //    {app_id, access_token}; a WS LOGI exchanges access_token → session key
  //    which authenticates the REST API. See UPLOAD_PLAN.md.)
  let _sessionKey = null;

  function _getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  async function fetchChatConfig() {
    const h = { accept: "application/json", "x-requested-with": "XMLHttpRequest" };
    const xsrf = _getCookie("XSRF-TOKEN");
    if (xsrf) h["x-xsrf-token"] = xsrf;
    const r = await fetch("/api/chat/config", { headers: h, credentials: "include" });
    if (!r.ok) return { error: "config " + r.status, status: r.status };
    const j = await r.json().catch(() => ({}));
    if (!j.app_id || !j.access_token) return { error: "config missing app_id/access_token" };
    return { appId: j.app_id, accessToken: j.access_token };
  }
  function mintSessionKey(appId, accessToken, userId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch (_) {} resolve(v); } };
      const wsUrl = "wss://ws-" + String(appId).toLowerCase() + ".sendbird.com/?p=JS&pv=4.22.0&sv=4.22.0&ai=" +
        appId + "&user_id=" + encodeURIComponent(userId) + "&access_token=" + encodeURIComponent(accessToken);
      const ws = new WebSocket(wsUrl);
      const to = setTimeout(() => finish(null), 10000);
      ws.onmessage = (ev) => {
        const d = String(ev.data || "");
        if (d.slice(0, 4) === "LOGI") {
          clearTimeout(to);
          try { finish(JSON.parse(d.slice(4)).key || null); } catch (_) { finish(null); }
        }
      };
      ws.onerror = () => { clearTimeout(to); finish(null); };
    });
  }
  async function getCreds() {
    const cfg = w.v2 && w.v2.chatConfig;
    const userId = w.v2 && w.v2.id != null ? String(w.v2.id) : null;
    if (!userId) return null;
    // Prefer the live config endpoint; fall back to window.v2.chatConfig.
    let appId = null, accessToken = null;
    const fetched = await fetchChatConfig().catch(() => null);
    if (fetched && !fetched.error) { appId = fetched.appId; accessToken = fetched.accessToken; }
    else if (cfg) { appId = cfg.app_id || null; accessToken = cfg.access_token || cfg.token || null; }
    if (!appId || !accessToken) return null;
    const key = await mintSessionKey(appId, accessToken, userId);
    if (!key) return null;
    _sessionKey = key;
    return { sessionKey: key, appId, userId };
  }
  function headers(appId, extra) {
    return Object.assign({
      "Session-key": _sessionKey,
      "App-Id": appId,
      "SendBird": "JS,web,4.22.0," + appId,
      "SB-User-Agent": "JS/c4.22.0///oweb",
    }, extra || {});
  }
  function isSelf(name) {
    const s = String(name || "").trim().toLowerCase();
    return s === "@me" || s === "@self" || s === "(me)";
  }
  function classify(status) {
    return (status === 401 || status === 403) ? "AUTH" : "REST_FAIL";
  }
  async function listChannels(base, userId, hdrs) {
    let all = [], token = "";
    for (let page = 0; page < 10; page++) {
      const url = base + "/users/" + encodeURIComponent(userId) +
        "/my_group_channels?limit=100&show_member=true" + (token ? "&token=" + encodeURIComponent(token) : "");
      const r = await fetch(url, { headers: hdrs });
      if (!r.ok) return { error: "list " + r.status, status: r.status };
      const j = await r.json().catch(() => ({}));
      all = all.concat(j.channels || []);
      token = j.next;
      if (!token || !(j.channels || []).length) break;
    }
    return { channels: all };
  }
  async function findOrCreateSelf(base, userId, hdrs, appId) {
    const listed = await listChannels(base, userId, hdrs);
    if (listed.error) return { error: listed.error, status: listed.status };
    const self = (listed.channels || []).find((c) =>
      (c.members || []).length === 1 && String((c.members[0] || {}).user_id) === String(userId));
    if (self) return { channel: self };
    const r = await fetch(base + "/group_channels", {
      method: "POST",
      headers: headers(appId, { "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ user_ids: [userId], is_distinct: true, name: "MetricShot (me)" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: "create " + r.status + ": " + (j.message || ""), status: r.status };
    return { channel: j };
  }
  async function resolve(base, userId, hdrs, appId, channelName) {
    if (isSelf(channelName)) return await findOrCreateSelf(base, userId, hdrs, appId);
    const listed = await listChannels(base, userId, hdrs);
    if (listed.error) return { error: listed.error, status: listed.status };
    const wanted = String(channelName).trim().toLowerCase();
    const match = (listed.channels || []).find((c) => String(c.name || "").trim().toLowerCase() === wanted);
    if (!match) return { error: "channel not joined: " + channelName, notFound: true };
    return { channel: match };
  }

  const c = await getCreds();
  if (!c) return { ok: false, errorClass: "NO_SESSION", error: "could not obtain Sendbird credentials — sign in to Workvivo, then retry" };
  if (!c.appId || !c.userId) return { ok: false, errorClass: "NO_SESSION", error: "missing app/user id" };
  const base = "https://api-" + String(c.appId).toLowerCase() + ".sendbird.com/v3";
  const hdrs = headers(c.appId);

  const res = await resolve(base, c.userId, hdrs, c.appId, arg.channelName);
  if (res.error) return { ok: false, errorClass: res.notFound ? "NOT_FOUND" : classify(res.status), error: res.error };
  const channel = res.channel;

  if (arg.action === "resolve") {
    return { ok: true, channelUrl: channel.channel_url, name: channel.name };
  }

  if (arg.action === "text") {
    const r = await fetch(base + "/group_channels/" + encodeURIComponent(channel.channel_url) + "/messages", {
      method: "POST",
      headers: headers(c.appId, { "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ message_type: "MESG", user_id: c.userId, message: String(arg.text) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, errorClass: classify(r.status), error: "post " + r.status + ": " + (j.message || "") };
    return { ok: true, channelUrl: channel.channel_url, messageId: String(j.message_id || "sent") };
  }

  return { ok: false, errorClass: "INPUT", error: "unknown action: " + arg.action };
}
