// modules/metricshot/lib/sendbird.js
//
// Posts a screenshot to a named Workvivo/Sendbird group channel using the
// SendBird SDK already loaded in the user's workvivo.walmart.com tab.
//
// Two paths, decided at run time:
//   1. Primary — MAIN-world function inside the workvivo tab that finds
//      the SDK, queries for the channel by name, and calls sendFileMessage.
//      All auth is handled by the SDK's live session, so we never touch
//      cookies or tokens.
//   2. Fallback — same tab context, but calls the Sendbird Platform REST
//      API via fetch. Still MAIN-world so the request inherits the page's
//      network context.
//
// Both paths require a workvivo.walmart.com tab that is authenticated. If
// none exists we surface a NO_TAB error and the caller retries next tick.
//
// Note on function serialization: chrome.scripting.executeScript({ func })
// only serializes the top-level function's own body. Helpers defined
// elsewhere in this module are NOT visible in the tab context — every
// in-page function below is fully self-contained.

const WORKVIVO_PATTERN = "https://workvivo.walmart.com/*";

/**
 * Send a text-only message into the given channel. Used for follow-up
 * details (e.g. un-scanned bins list) that accompany a screenshot post.
 *
 * @param {object} args
 * @param {string} args.channelName
 * @param {string} args.text
 * @returns {Promise<{ok:boolean, path:"sdk"|"rest"|"none", channelUrl?:string, messageId?:string, error?:string, errorClass?:string}>}
 */
export async function postTextToWorkvivo({ channelName, text }) {
  if (!text || typeof text !== "string") return { ok: false, path: "none", errorClass: "INPUT", error: "missing text" };
  if (!channelName) return { ok: false, path: "none", errorClass: "INPUT", error: "missing channelName" };

  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, path: "none", errorClass: tabRes.errorClass, error: tabRes.error };
  const { tabId, openedFresh } = tabRes;

  try {
    const viaSdk = await _runInTab(tabId, IN_PAGE_POST_TEXT_VIA_SDK, [{ channelName, text }]);
    if (viaSdk?.ok) return { ...viaSdk, path: "sdk" };
    if (viaSdk?.errorClass === "AUTH") return { ...viaSdk, path: "sdk" };
    const viaRest = await _runInTab(tabId, IN_PAGE_POST_TEXT_VIA_REST, [{ channelName, text }]);
    return { ...(viaRest || { ok: false, errorClass: "REST_FAIL", error: "no result" }), path: "rest" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

/**
 * @param {object} args
 * @param {string} args.channelName     e.g. "1458 Leadership"
 * @param {string} args.pngBase64
 * @param {string} args.fileName        e.g. "vizpick-2026-07-26T14-00.png"
 * @param {string} [args.caption]
 * @returns {Promise<{ok:boolean, path:"sdk"|"rest"|"none", channelUrl?:string, messageId?:string, error?:string, errorClass?:string}>}
 */
export async function postScreenshotToWorkvivo({ channelName, pngBase64, fileName, caption }) {
  if (!pngBase64) return { ok: false, path: "none", errorClass: "INPUT", error: "missing pngBase64" };
  if (!channelName) return { ok: false, path: "none", errorClass: "INPUT", error: "missing channelName" };

  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, path: "none", errorClass: tabRes.errorClass, error: tabRes.error };
  const { tabId, openedFresh } = tabRes;

  try {
    // Try SDK path first.
    const viaSdk = await _runInTab(tabId, IN_PAGE_POST_VIA_SDK, [{ channelName, pngBase64, fileName, caption }]);
    if (viaSdk?.ok) return { ...viaSdk, path: "sdk" };
    if (viaSdk?.errorClass === "AUTH") {
      return { ...viaSdk, path: "sdk" };                                   // don't retry via REST if token is bad
    }
    // Fall through to REST.
    const viaRest = await _runInTab(tabId, IN_PAGE_POST_VIA_REST, [{ channelName, pngBase64, fileName, caption }]);
    return { ...(viaRest || { ok: false, errorClass: "REST_FAIL", error: "no result" }), path: "rest" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

/**
 * Resolve the given channelName to a channel URL without posting. Used by
 * the UI's "Validate destination" action + as a pre-flight before capture.
 */
export async function resolveChannel(channelName) {
  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, errorClass: tabRes.errorClass, error: tabRes.error };
  const { tabId, openedFresh } = tabRes;
  try {
    const r = await _runInTab(tabId, IN_PAGE_RESOLVE_CHANNEL, [channelName]);
    return r || { ok: false, errorClass: "SDK_MISSING", error: "no result" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

/**
 * Locate a live workvivo.walmart.com tab whose Sendbird SDK is loaded. If
 * none exists, open one in the background and wait for the SDK to appear.
 *
 * Mirrors the openWorkvivoTab + waitForLiveToken pattern used by the
 * workvivo module's manual heartbeat path (modules/workvivo/lib/extract.js).
 * We keep this local rather than importing across the module boundary so
 * metricshot doesn't take a runtime dependency on workvivo.
 *
 * If we open the tab ourselves, the caller closes it after the operation
 * via _closeIfOwn — user-owned tabs are never touched. Reopening on each
 * post costs ~15–45 s of SDK bootstrap; that's the price for not leaving
 * a workvivo tab sitting in the user's tab strip between posts.
 */
async function _ensureWorkvivoTab({ waitMs = 45_000 } = {}) {
  // Fast path: an existing tab whose SDK is already up.
  const existing = await _findWorkvivoTabsSorted();
  for (const tab of existing) {
    if (await _sdkReady(tab.id)) return { ok: true, tabId: tab.id, openedFresh: false };
  }
  if (existing.length) {
    // A tab exists but the SDK isn't loaded yet — wait for it (user just
    // navigated, page is still bootstrapping).
    const ready = await _waitForSdk(existing[0].id, Math.min(waitMs, 15_000));
    if (ready) return { ok: true, tabId: existing[0].id, openedFresh: false };
  }

  // No usable tab — open one in the background.
  const tab = await chrome.tabs.create({ url: "https://workvivo.walmart.com/chat", active: false })
    .catch((e) => ({ __err: String(e?.message ?? e) }));
  if (!tab || tab.__err || !tab.id) {
    return { ok: false, errorClass: "NO_TAB", error: `could not open workvivo tab: ${tab?.__err || "unknown"}` };
  }

  const ready = await _waitForSdk(tab.id, waitMs);
  if (!ready) {
    return {
      ok: false, errorClass: "NO_SDK",
      error: `opened workvivo tab but Sendbird SDK didn't appear within ${Math.round(waitMs/1000)}s — sign in to Workvivo, then retry`,
    };
  }
  return { ok: true, tabId: tab.id, openedFresh: true };
}

async function _findWorkvivoTabsSorted() {
  const tabs = await chrome.tabs.query({ url: WORKVIVO_PATTERN });
  return tabs.filter((t) => typeof t.id === "number")
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
}

async function _sdkReady(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      func: () => {
        const w = /** @type any */ (globalThis);
        const candidates = [
          w.v2 && w.v2.chat && w.v2.chat.sdk,
          w.v2 && w.v2.chatSdk,
          w.SendBird && (typeof w.SendBird.getInstance === "function" ? w.SendBird.getInstance() : null),
          w.sb, w.sendbird,
        ].filter(Boolean);
        return candidates.some((c) =>
          c?.groupChannel?.createMyGroupChannelListQuery ||
          c?.GroupChannel?.createMyGroupChannelListQuery
        );
      },
    });
    return res?.[0]?.result === true;
  } catch (_) {
    return false;
  }
}

async function _waitForSdk(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // First wait for the tab to reach `complete` — no point probing during load.
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") break;
    await _delay(300);
  }
  while (Date.now() < deadline) {
    if (await _sdkReady(tabId)) return true;
    await _delay(750);
  }
  return false;
}

/**
 * Close a workvivo tab only if we opened it ourselves in this operation.
 * User-opened tabs (openedFresh === false) are left alone — closing them
 * would steal an active chat session mid-conversation.
 */
async function _closeIfOwn(tabId, openedFresh) {
  if (!openedFresh) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    // Tab already gone (user closed it, or the browser did) — nothing to do.
  }
}

function _delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// ── In-page functions ─────────────────────────────────────────────────────
// PURE. Self-contained. Serialized into the workvivo.walmart.com tab and
// executed in its MAIN-world global scope, where window.v2 / SendBird SDK
// are visible.

// Resolve channel by name. Returns { ok, channelUrl, name } or { ok:false, ... }.
function IN_PAGE_RESOLVE_CHANNEL(channelName) {
  const w = /** @type any */ (globalThis);
  function locateSdk() {
    const candidates = [
      w.v2 && w.v2.chat && w.v2.chat.sdk,
      w.v2 && w.v2.chatSdk,
      w.SendBird && (typeof w.SendBird.getInstance === "function" ? w.SendBird.getInstance() : null),
      w.sb,
      w.sendbird,
    ].filter(Boolean);
    for (const c of candidates) {
      if (c?.groupChannel?.createMyGroupChannelListQuery) return { sdk: c, api: "v4" };
      if (c?.GroupChannel?.createMyGroupChannelListQuery) return { sdk: c, api: "v3" };
    }
    return null;
  }
  async function findChannel(found, name) {
    const { sdk, api } = found;
    let query;
    if (api === "v4") {
      query = sdk.groupChannel.createMyGroupChannelListQuery({ limit: 100, includeEmpty: true });
    } else {
      query = sdk.GroupChannel.createMyGroupChannelListQuery();
      query.limit = 100;
      query.includeEmpty = true;
    }
    const wanted = String(name).trim().toLowerCase();
    for (let page = 0; page < 5; page++) {
      const list = await new Promise((res, rej) => {
        try {
          if (typeof query.next === "function" && query.next.length === 0) {
            Promise.resolve(query.next()).then(res, rej);
          } else {
            query.next((channels, err) => err ? rej(err) : res(channels || []));
          }
        } catch (e) { rej(e); }
      });
      for (const ch of list) {
        const n = String(ch.name || "").trim().toLowerCase();
        if (n === wanted) return ch;
      }
      if (!list || !list.length) break;
      if (typeof query.hasNext === "boolean" && !query.hasNext) break;
    }
    return null;
  }

  return (async () => {
    try {
      const found = locateSdk();
      if (!found) return { ok: false, errorClass: "SDK_MISSING", error: "no SendBird SDK found" };
      const channel = await findChannel(found, channelName);
      if (!channel) return { ok: false, errorClass: "NOT_FOUND", error: `channel not joined: ${channelName}` };
      return { ok: true, channelUrl: channel.url, name: channel.name || channelName };
    } catch (e) {
      return { ok: false, errorClass: "PROBE_FAIL", error: String((e && e.message) || e) };
    }
  })();
}

// Post via SDK. Returns { ok, channelUrl, messageId } or { ok:false, ... }.
function IN_PAGE_POST_VIA_SDK({ channelName, pngBase64, fileName, caption }) {
  const w = /** @type any */ (globalThis);
  function locateSdk() {
    const candidates = [
      w.v2 && w.v2.chat && w.v2.chat.sdk,
      w.v2 && w.v2.chatSdk,
      w.SendBird && (typeof w.SendBird.getInstance === "function" ? w.SendBird.getInstance() : null),
      w.sb,
      w.sendbird,
    ].filter(Boolean);
    for (const c of candidates) {
      if (c?.groupChannel?.createMyGroupChannelListQuery) return { sdk: c, api: "v4" };
      if (c?.GroupChannel?.createMyGroupChannelListQuery) return { sdk: c, api: "v3" };
    }
    return null;
  }
  async function findChannel(found, name) {
    const { sdk, api } = found;
    let query;
    if (api === "v4") {
      query = sdk.groupChannel.createMyGroupChannelListQuery({ limit: 100, includeEmpty: true });
    } else {
      query = sdk.GroupChannel.createMyGroupChannelListQuery();
      query.limit = 100;
      query.includeEmpty = true;
    }
    const wanted = String(name).trim().toLowerCase();
    for (let page = 0; page < 5; page++) {
      const list = await new Promise((res, rej) => {
        try {
          if (typeof query.next === "function" && query.next.length === 0) {
            Promise.resolve(query.next()).then(res, rej);
          } else {
            query.next((channels, err) => err ? rej(err) : res(channels || []));
          }
        } catch (e) { rej(e); }
      });
      for (const ch of list) {
        const n = String(ch.name || "").trim().toLowerCase();
        if (n === wanted) return ch;
      }
      if (!list || !list.length) break;
      if (typeof query.hasNext === "boolean" && !query.hasNext) break;
    }
    return null;
  }

  return (async () => {
    try {
      const found = locateSdk();
      if (!found) return { ok: false, errorClass: "SDK_MISSING", error: "no SendBird SDK" };
      const channel = await findChannel(found, channelName);
      if (!channel) return { ok: false, errorClass: "NOT_FOUND", error: `channel not joined: ${channelName}` };

      const bin = atob(pngBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      let file;
      try {
        file = new File([blob], fileName, { type: "image/png" });
      } catch (_) {
        file = blob;
      }

      const params = {
        file,
        fileName,
        mimeType: "image/png",
        fileSize: bytes.length,
        message: String(caption || ""),
      };

      const messageId = await new Promise((resolve, reject) => {
        try {
          if (typeof channel.sendFileMessage !== "function") {
            reject(new Error("channel has no sendFileMessage"));
            return;
          }
          const handler = channel.sendFileMessage(params, (msg, err) => {
            if (err) return reject(err);
            resolve(msg?.messageId || msg?.reqId || "sent");
          });
          if (handler && typeof handler.onSucceeded === "function") {
            handler.onSucceeded((msg) => resolve(msg?.messageId || msg?.reqId || "sent"));
            if (typeof handler.onFailed === "function") handler.onFailed(reject);
          }
        } catch (e) { reject(e); }
      });

      return { ok: true, channelUrl: channel.url, messageId: String(messageId) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const code = (e && (e.code || e.errorCode)) || null;
      let errorClass = "SDK_FAIL";
      if (code === 400302 || code === 400309 || /invalid.*token|auth/i.test(msg)) errorClass = "AUTH";
      if (code === 400201 || /not.*found|no.*such.*channel/i.test(msg)) errorClass = "NOT_FOUND";
      return { ok: false, errorClass, error: msg, code };
    }
  })();
}

// Post via Sendbird Platform REST. Runs in the same MAIN-world so fetch()
// inherits the page's network context.
function IN_PAGE_POST_VIA_REST({ channelName, pngBase64, fileName, caption }) {
  return (async () => {
    try {
      const w = /** @type any */ (globalThis);
      const cfg = w.v2 && w.v2.chatConfig;
      if (!cfg) return { ok: false, errorClass: "SDK_MISSING", error: "window.v2.chatConfig unavailable" };
      const accessToken = cfg.access_token || cfg.token;
      const appId = cfg.app_id;
      const userId = w.v2 && (w.v2.id != null ? String(w.v2.id) : null);
      if (!accessToken) return { ok: false, errorClass: "AUTH", error: "no access_token in chatConfig" };
      if (!appId)       return { ok: false, errorClass: "SDK_MISSING", error: "no app_id in chatConfig" };
      if (!userId)      return { ok: false, errorClass: "SDK_MISSING", error: "no userId (v2.id) in page" };

      const base = `https://api-${appId}.sendbird.com/v3`;
      const headers = { "Session-Token": accessToken };

      const listResp = await fetch(`${base}/users/${encodeURIComponent(userId)}/my_group_channels?limit=100&show_member=false`, { headers });
      if (!listResp.ok) {
        return { ok: false, errorClass: (listResp.status === 401 || listResp.status === 403) ? "AUTH" : "REST_FAIL", error: `list ${listResp.status}` };
      }
      const listJson = await listResp.json().catch(() => ({}));
      const wanted = String(channelName).trim().toLowerCase();
      let match = (listJson.channels || []).find((c) => String(c.name || "").trim().toLowerCase() === wanted);
      let nextToken = listJson.next;
      while (!match && nextToken) {
        const r = await fetch(`${base}/users/${encodeURIComponent(userId)}/my_group_channels?limit=100&show_member=false&token=${encodeURIComponent(nextToken)}`, { headers });
        if (!r.ok) break;
        const j = await r.json().catch(() => ({}));
        match = (j.channels || []).find((c) => String(c.name || "").trim().toLowerCase() === wanted);
        nextToken = j.next;
        if (!j.channels?.length) break;
      }
      if (!match) return { ok: false, errorClass: "NOT_FOUND", error: `channel not joined: ${channelName}` };

      const bin = atob(pngBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });

      const form = new FormData();
      form.append("message_type", "FILE");
      form.append("user_id", userId);
      form.append("message", String(caption || ""));
      form.append("file", blob, fileName);

      const postResp = await fetch(`${base}/group_channels/${encodeURIComponent(match.channel_url)}/messages`, {
        method: "POST",
        headers,
        body: form,
      });
      const postJson = await postResp.json().catch(() => ({}));
      if (!postResp.ok) {
        return { ok: false, errorClass: (postResp.status === 401 || postResp.status === 403) ? "AUTH" : "REST_FAIL", error: `post ${postResp.status}: ${postJson.message || ""}` };
      }
      return { ok: true, channelUrl: match.channel_url, messageId: String(postJson.message_id || "sent") };
    } catch (e) {
      return { ok: false, errorClass: "REST_FAIL", error: String((e && e.message) || e) };
    }
  })();
}

// Post text via SDK. Returns { ok, channelUrl, messageId } or { ok:false, ... }.
function IN_PAGE_POST_TEXT_VIA_SDK({ channelName, text }) {
  const w = /** @type any */ (globalThis);
  function locateSdk() {
    const candidates = [
      w.v2 && w.v2.chat && w.v2.chat.sdk,
      w.v2 && w.v2.chatSdk,
      w.SendBird && (typeof w.SendBird.getInstance === "function" ? w.SendBird.getInstance() : null),
      w.sb, w.sendbird,
    ].filter(Boolean);
    for (const c of candidates) {
      if (c?.groupChannel?.createMyGroupChannelListQuery) return { sdk: c, api: "v4" };
      if (c?.GroupChannel?.createMyGroupChannelListQuery) return { sdk: c, api: "v3" };
    }
    return null;
  }
  async function findChannel(found, name) {
    const { sdk, api } = found;
    let query;
    if (api === "v4") {
      query = sdk.groupChannel.createMyGroupChannelListQuery({ limit: 100, includeEmpty: true });
    } else {
      query = sdk.GroupChannel.createMyGroupChannelListQuery();
      query.limit = 100;
      query.includeEmpty = true;
    }
    const wanted = String(name).trim().toLowerCase();
    for (let page = 0; page < 5; page++) {
      const list = await new Promise((res, rej) => {
        try {
          if (typeof query.next === "function" && query.next.length === 0) {
            Promise.resolve(query.next()).then(res, rej);
          } else {
            query.next((channels, err) => err ? rej(err) : res(channels || []));
          }
        } catch (e) { rej(e); }
      });
      for (const ch of list) {
        const n = String(ch.name || "").trim().toLowerCase();
        if (n === wanted) return ch;
      }
      if (!list || !list.length) break;
      if (typeof query.hasNext === "boolean" && !query.hasNext) break;
    }
    return null;
  }

  return (async () => {
    try {
      const found = locateSdk();
      if (!found) return { ok: false, errorClass: "SDK_MISSING", error: "no SendBird SDK" };
      const channel = await findChannel(found, channelName);
      if (!channel) return { ok: false, errorClass: "NOT_FOUND", error: `channel not joined: ${channelName}` };

      const messageId = await new Promise((resolve, reject) => {
        try {
          if (typeof channel.sendUserMessage !== "function") {
            reject(new Error("channel has no sendUserMessage"));
            return;
          }
          const handler = channel.sendUserMessage({ message: String(text) }, (msg, err) => {
            if (err) return reject(err);
            resolve(msg?.messageId || msg?.reqId || "sent");
          });
          if (handler && typeof handler.onSucceeded === "function") {
            handler.onSucceeded((msg) => resolve(msg?.messageId || msg?.reqId || "sent"));
            if (typeof handler.onFailed === "function") handler.onFailed(reject);
          }
        } catch (e) { reject(e); }
      });

      return { ok: true, channelUrl: channel.url, messageId: String(messageId) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const code = (e && (e.code || e.errorCode)) || null;
      let errorClass = "SDK_FAIL";
      if (code === 400302 || code === 400309 || /invalid.*token|auth/i.test(msg)) errorClass = "AUTH";
      if (code === 400201 || /not.*found|no.*such.*channel/i.test(msg)) errorClass = "NOT_FOUND";
      return { ok: false, errorClass, error: msg, code };
    }
  })();
}

// Post text via REST (same MAIN-world fetch context as file post).
function IN_PAGE_POST_TEXT_VIA_REST({ channelName, text }) {
  return (async () => {
    try {
      const w = /** @type any */ (globalThis);
      const cfg = w.v2 && w.v2.chatConfig;
      if (!cfg) return { ok: false, errorClass: "SDK_MISSING", error: "window.v2.chatConfig unavailable" };
      const accessToken = cfg.access_token || cfg.token;
      const appId = cfg.app_id;
      const userId = w.v2 && (w.v2.id != null ? String(w.v2.id) : null);
      if (!accessToken) return { ok: false, errorClass: "AUTH", error: "no access_token in chatConfig" };
      if (!appId)       return { ok: false, errorClass: "SDK_MISSING", error: "no app_id in chatConfig" };
      if (!userId)      return { ok: false, errorClass: "SDK_MISSING", error: "no userId (v2.id) in page" };

      const base = `https://api-${appId}.sendbird.com/v3`;

      const listResp = await fetch(`${base}/users/${encodeURIComponent(userId)}/my_group_channels?limit=100&show_member=false`, { headers: { "Session-Token": accessToken } });
      if (!listResp.ok) {
        return { ok: false, errorClass: (listResp.status === 401 || listResp.status === 403) ? "AUTH" : "REST_FAIL", error: `list ${listResp.status}` };
      }
      const listJson = await listResp.json().catch(() => ({}));
      const wanted = String(channelName).trim().toLowerCase();
      let match = (listJson.channels || []).find((c) => String(c.name || "").trim().toLowerCase() === wanted);
      let nextToken = listJson.next;
      while (!match && nextToken) {
        const r = await fetch(`${base}/users/${encodeURIComponent(userId)}/my_group_channels?limit=100&show_member=false&token=${encodeURIComponent(nextToken)}`, { headers: { "Session-Token": accessToken } });
        if (!r.ok) break;
        const j = await r.json().catch(() => ({}));
        match = (j.channels || []).find((c) => String(c.name || "").trim().toLowerCase() === wanted);
        nextToken = j.next;
        if (!j.channels?.length) break;
      }
      if (!match) return { ok: false, errorClass: "NOT_FOUND", error: `channel not joined: ${channelName}` };

      const postResp = await fetch(`${base}/group_channels/${encodeURIComponent(match.channel_url)}/messages`, {
        method: "POST",
        headers: { "Session-Token": accessToken, "Content-Type": "application/json; charset=utf8" },
        body: JSON.stringify({
          message_type: "MESG",
          user_id: userId,
          message: String(text),
        }),
      });
      const postJson = await postResp.json().catch(() => ({}));
      if (!postResp.ok) {
        return { ok: false, errorClass: (postResp.status === 401 || postResp.status === 403) ? "AUTH" : "REST_FAIL", error: `post ${postResp.status}: ${postJson.message || ""}` };
      }
      return { ok: true, channelUrl: match.channel_url, messageId: String(postJson.message_id || "sent") };
    } catch (e) {
      return { ok: false, errorClass: "REST_FAIL", error: String((e && e.message) || e) };
    }
  })();
}
