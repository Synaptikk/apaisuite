// modules/metricshot/lib/sendbird.js
//
// Posts screenshots + text to a Workvivo/Sendbird group channel via the
// Sendbird Platform REST API.
//
// ── Why REST, not the SDK ──────────────────────────────────────────────────
// The Sendbird JS SDK is NEVER exposed on `window` at workvivo.walmart.com
// (confirmed 2026-07-28 via CDP: no global, no iframe, v2.chat=false). Every
// SDK-detection strategy was therefore doomed. But the SDK talks to
// api-{appid}.sendbird.com/v3 with a rotating `Session-key` header, and that
// key is AES-encrypted in IndexedDB (unreadable).
//
// So the flow is:
//   1. A MAIN-world content script (content/wv_session_sniffer.js) patches
//      fetch/XHR on the workvivo tab and captures the live `Session-key`,
//      `App-Id`, and `user_id` off the SDK's own outbound requests. It stashes
//      them on window.__APAISUITE_METRICSHOT_SBKEY.
//   2. Here we open our own fresh workvivo tab, wait for the sniffer to grab a
//      key, then run an in-page REST helper (MAIN world, so it inherits the
//      page's network/CORS context) that posts using the exact header recipe
//      the real SDK uses.
//
// Header recipe proven to return 200 (2026-07-28):
//   Session-key, App-Id, Content-Type: application/json; charset=utf-8,
//   SendBird: JS,web,4.22.0,{appId}, SB-User-Agent: JS/c4.22.0///oweb
// All four are load-bearing and asserted in lib/tests/sendbird_rest.test.mjs.
//
// The Session-key rotates. Every request goes through sbFetch(), which on a
// 401/403 waits up to 3s for the sniffer to observe a newer key and replays
// the request once — a rotation between channel-resolve and send used to lose
// the whole post.
//
// KNOWN BROKEN: the "file" action. Sendbird rejects multipart sends on this
// auth path with 400 "File-messages via SDK are disabled", so screenshot
// posting does not currently work. The sniffer's net-recon ring buffer
// (window.__APAISUITE_METRICSHOT_NETLOG) exists to discover the upload route
// Workvivo's own UI uses. Text sends are unaffected and work.
//
// Channel targeting:
//   - "@me" / "@self" / "(me)"  → find-or-create the 1-member self channel
//   - anything else             → match a joined channel by name
//
// Note on serialization: chrome.scripting.executeScript({ func }) only
// serializes the top-level function body — helpers must be inlined. Every
// IN_PAGE_* function below is fully self-contained.

const WORKVIVO_URL = "https://workvivo.walmart.com/chat";
const SBKEY_GLOBAL = "__APAISUITE_METRICSHOT_SBKEY";

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
 * @returns {Promise<{ok:boolean, path:"rest"|"none", channelUrl?:string, messageId?:string, error?:string, errorClass?:string}>}
 */
export async function postScreenshotToWorkvivo({ channelName, pngBase64, fileName, caption, onStep }) {
  const step = (name, extra) => { try { onStep?.(name, extra); } catch { /* ignore */ } };
  if (!pngBase64) return { ok: false, path: "none", errorClass: "INPUT", error: "missing pngBase64" };
  if (!channelName) return { ok: false, path: "none", errorClass: "INPUT", error: "missing channelName" };

  step("ensure-tab");
  const tabRes = await _ensureWorkvivoTab({ onStep: step });
  if (!tabRes.ok) return { ok: false, path: "none", errorClass: tabRes.errorClass, error: tabRes.error, debug: tabRes.debug };
  const { tabId, openedFresh } = tabRes;
  step("tab-ready", { tabId, openedFresh });

  try {
    step("rest-post");
    const r = await _runInTab(tabId, IN_PAGE_SB, [{ action: "file", channelName, pngBase64, fileName, caption }]);
    step("rest-post-done", { ok: !!r?.ok, errorClass: r?.errorClass });
    return { ...(r || { ok: false, errorClass: "REST_FAIL", error: "no result" }), path: "rest" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
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
 * List the group channels this user has joined, for the destination picker.
 *
 * Returns { ok, channels: [{ channelUrl, name, memberCount, isSelf }], truncated }.
 * `truncated` means we stopped at the page cap rather than the end of the list,
 * so a channel missing from the dropdown means "we didn't look everywhere",
 * not "you aren't in it" — the UI says so rather than implying the latter.
 */
export async function listWorkvivoChannels() {
  const tabRes = await _ensureWorkvivoTab();
  if (!tabRes.ok) return { ok: false, errorClass: tabRes.errorClass, error: tabRes.error };
  const { tabId, openedFresh } = tabRes;
  try {
    const r = await _runInTab(tabId, IN_PAGE_SB, [{ action: "list" }]);
    return r || { ok: false, errorClass: "REST_FAIL", error: "no result" };
  } finally {
    await _closeIfOwn(tabId, openedFresh);
  }
}

/**
 * Diagnostic: report what the session-key sniffer has captured (or not) on a
 * live workvivo tab. Surfaced by the UI's troubleshoot action.
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
 * Always open our OWN fresh background workvivo tab, wait for the session-key
 * sniffer to capture live creds, and return it with openedFresh:true so the
 * caller (_closeIfOwn) closes it after posting. We never reuse the user's tab
 * (avoids hijacking their session).
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

  // Poll the sniffer global. The SDK fires authenticated calls within ~1-2s of
  // load, but background tabs are throttled so give it a hidden grace period,
  // then briefly foreground to force the SDK to boot if needed.
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
      error: `opened workvivo tab but no Sendbird session-key was captured within ${Math.round(waitMs / 1000)}s — sign in to Workvivo, then retry`,
      debug: probe,
    };
  }
  step("creds-ready", { userId: creds.userId, hasKey: !!creds.sessionKey });
  return { ok: true, tabId: tab.id, openedFresh: true };
}

async function _waitForCreds(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null; // tab gone
    const r = await _runInTab(tabId, IN_PAGE_READ_CREDS, []).catch(() => null);
    if (r && r.sessionKey) return r;
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

/** Read whatever creds the sniffer has captured. */
function IN_PAGE_READ_CREDS() {
  const w = /** @type any */ (globalThis);
  const c = w.__APAISUITE_METRICSHOT_SBKEY;
  if (!c || !c.sessionKey) return null;
  // Fall back to page globals for appId/userId if the sniffer missed them.
  const cfg = w.v2 && w.v2.chatConfig;
  return {
    sessionKey: c.sessionKey,
    appId: c.appId || (cfg && cfg.app_id) || null,
    userId: c.userId || (w.v2 && w.v2.id != null ? String(w.v2.id) : null),
    ageMs: c.ts ? Date.now() - c.ts : null,
  };
}

/** Diagnostic snapshot of sniffer + page state. */
function IN_PAGE_INTROSPECT() {
  const w = /** @type any */ (globalThis);
  const c = w.__APAISUITE_METRICSHOT_SBKEY;
  const cfg = w.v2 && w.v2.chatConfig;
  return {
    snifferInstalled: !!w.__APAISUITE_METRICSHOT_SBKEY_INSTALLED,
    hasSessionKey: !!(c && c.sessionKey),
    keyAgeMs: c && c.ts ? Date.now() - c.ts : null,
    appId: (c && c.appId) || (cfg && cfg.app_id) || null,
    userId: (c && c.userId) || (w.v2 && w.v2.id != null ? String(w.v2.id) : null),
    href: location.href,
    signedIn: !!(w.v2 && w.v2.id),
    netlog: (w.__APAISUITE_METRICSHOT_NETLOG || []).slice(-30),
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
 * actions: "resolve" | "text" | "file"
 */
async function IN_PAGE_SB(arg) {
  const w = /** @type any */ (globalThis);

  // Live credential slot, not a one-time snapshot: the Session-key rotates,
  // and a post spans channel-resolve → send, so it can straddle a rotation.
  let c = null;

  function readCreds() {
    const cur = w.__APAISUITE_METRICSHOT_SBKEY;
    if (!cur || !cur.sessionKey) return null;
    const cfg = w.v2 && w.v2.chatConfig;
    return {
      sessionKey: cur.sessionKey,
      appId: cur.appId || (cfg && cfg.app_id) || null,
      userId: cur.userId || (w.v2 && w.v2.id != null ? String(w.v2.id) : null),
      ageMs: cur.ts ? Date.now() - cur.ts : null,
    };
  }
  // Reads `c` — callers must not reach it before the NO_SESSION guard below.
  function headers(extra) {
    return Object.assign({
      "Session-key": c.sessionKey,
      "App-Id": c.appId,
      "SendBird": "JS,web,4.22.0," + c.appId,
      "SB-User-Agent": "JS/c4.22.0///oweb",
    }, extra || {});
  }
  function delay(ms) { return new Promise((res) => setTimeout(res, ms)); }
  // Wait briefly for the sniffer to observe a key different from prevKey. The
  // SDK fires authenticated calls (presence, changelogs) continuously, so a
  // rotation lands within a second or two of the 401 that revealed it.
  async function awaitRotatedKey(prevKey, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const cur = readCreds();
      if (cur && cur.sessionKey !== prevKey) return cur;
      if (Date.now() >= deadline) return null;
      await delay(500);
    }
  }
  // Single fetch chokepoint: injects the proven header recipe and, on 401/403,
  // picks up a rotated key and replays the request once. Bodies here are
  // strings or FormData, both of which survive being sent twice.
  async function sbFetch(url, init, extra) {
    const send = () => fetch(url, Object.assign({}, init, { headers: headers(extra) }));
    const r = await send();
    if (r.status !== 401 && r.status !== 403) return r;
    const rotated = await awaitRotatedKey(c.sessionKey, 3000);
    if (!rotated) return r;
    c = rotated;
    return await send();
  }
  function isSelf(name) {
    const s = String(name || "").trim().toLowerCase();
    return s === "@me" || s === "@self" || s === "(me)";
  }
  function classify(status) {
    return (status === 401 || status === 403) ? "AUTH" : "REST_FAIL";
  }
  const MAX_PAGES = 10, PAGE_SIZE = 100;
  async function listChannels(base, userId) {
    let all = [], token = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = base + "/users/" + encodeURIComponent(userId) +
        "/my_group_channels?limit=" + PAGE_SIZE + "&show_member=true" +
        (token ? "&token=" + encodeURIComponent(token) : "");
      const r = await sbFetch(url, { method: "GET" });
      if (!r.ok) return { error: "list " + r.status, status: r.status };
      const j = await r.json().catch(() => ({}));
      all = all.concat(j.channels || []);
      token = j.next;
      if (!token || !(j.channels || []).length) break;
    }
    // A token still set means we stopped at the page cap, not at the end of
    // the list. Surfaced so a miss reads as "we didn't look everywhere"
    // instead of "you aren't in that channel".
    return { channels: all, truncated: !!token };
  }
  async function findOrCreateSelf(base, userId) {
    const listed = await listChannels(base, userId);
    if (listed.error) return { error: listed.error, status: listed.status };
    const self = (listed.channels || []).find((ch) =>
      (ch.members || []).length === 1 && String((ch.members[0] || {}).user_id) === String(userId));
    if (self) return { channel: self };
    const r = await sbFetch(base + "/group_channels", {
      method: "POST",
      body: JSON.stringify({ user_ids: [userId], is_distinct: true, name: "MetricShot (me)" }),
    }, { "Content-Type": "application/json; charset=utf-8" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: "create " + r.status + ": " + (j.message || ""), status: r.status };
    return { channel: j };
  }
  async function resolve(base, userId, channelName) {
    if (isSelf(channelName)) return await findOrCreateSelf(base, userId);
    const listed = await listChannels(base, userId);
    if (listed.error) return { error: listed.error, status: listed.status };
    const wanted = String(channelName).trim().toLowerCase();
    const match = (listed.channels || []).find((ch) => String(ch.name || "").trim().toLowerCase() === wanted);
    if (!match) {
      return listed.truncated
        ? { error: "channel not found in the first " + (MAX_PAGES * PAGE_SIZE) + " joined channels: " + channelName, status: 0 }
        : { error: "channel not joined: " + channelName, notFound: true };
    }
    return { channel: match };
  }

  c = readCreds();
  if (!c) return { ok: false, errorClass: "NO_SESSION", error: "no session-key captured yet" };
  if (!c.appId || !c.userId) return { ok: false, errorClass: "NO_SESSION", error: "missing app/user id" };
  const base = "https://api-" + String(c.appId).toLowerCase() + ".sendbird.com/v3";

  // Listing is the one action with no channelName to resolve, so it has to
  // short-circuit before resolve() — which would otherwise fail on undefined.
  if (arg.action === "list") {
    const listed = await listChannels(base, c.userId);
    if (listed.error) {
      return { ok: false, errorClass: classify(listed.status), error: listed.error, keyAgeMs: c.ageMs };
    }
    const channels = (listed.channels || []).map((ch) => {
      const members = ch.members || [];
      const self = members.length === 1 && String((members[0] || {}).user_id) === String(c.userId);
      return {
        channelUrl: String(ch.channel_url || ""),
        // Unnamed group channels are common; the URL tail is the only stable
        // thing left to show, and it is what the UI already prints elsewhere.
        name: String(ch.name || "").trim() || ("(unnamed …" + String(ch.channel_url || "").slice(-6) + ")"),
        memberCount: members.length,
        isSelf: self,
      };
    });
    return { ok: true, channels, truncated: !!listed.truncated };
  }

  const res = await resolve(base, c.userId, arg.channelName);
  if (res.error) {
    return {
      ok: false,
      errorClass: res.notFound ? "NOT_FOUND" : classify(res.status),
      error: res.error,
      keyAgeMs: c.ageMs,
    };
  }
  const channel = res.channel;

  if (arg.action === "resolve") {
    return { ok: true, channelUrl: channel.channel_url, name: channel.name };
  }

  if (arg.action === "text") {
    const r = await sbFetch(base + "/group_channels/" + encodeURIComponent(channel.channel_url) + "/messages", {
      method: "POST",
      body: JSON.stringify({ message_type: "MESG", user_id: c.userId, message: String(arg.text) }),
    }, { "Content-Type": "application/json; charset=utf-8" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, errorClass: classify(r.status), error: "post " + r.status + ": " + (j.message || ""), keyAgeMs: c.ageMs };
    }
    return { ok: true, channelUrl: channel.channel_url, messageId: String(j.message_id || "sent") };
  }

  if (arg.action === "file") {
    const bin = atob(arg.pngBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/png" });
    const form = new FormData();
    form.append("message_type", "FILE");
    form.append("user_id", c.userId);
    if (arg.caption) form.append("message", String(arg.caption));
    form.append("file", blob, arg.fileName || "screenshot.png");
    // NOTE: do NOT set Content-Type for multipart — the browser adds the boundary.
    const r = await sbFetch(base + "/group_channels/" + encodeURIComponent(channel.channel_url) + "/messages", {
      method: "POST",
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, errorClass: classify(r.status), error: "post " + r.status + ": " + (j.message || ""), keyAgeMs: c.ageMs };
    }
    return { ok: true, channelUrl: channel.channel_url, messageId: String(j.message_id || "sent") };
  }

  return { ok: false, errorClass: "INPUT", error: "unknown action: " + arg.action };
}
