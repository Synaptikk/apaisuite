// modules/metricshot/lib/workvivo_upload.js
//
// Posts an image to a Workvivo chat channel by driving Workvivo's OWN file
// composer via CDP — because Sendbird's REST API blocks file messages for this
// app (`400108 "File-messages via SDK are disabled."`, verified 2026-07-28).
// Text messages still go via REST (see sendbird.js); only images take this path.
//
// Why CDP and not chrome.scripting?
//   Workvivo's React composer ignores a synthetic `input.files = …` + change
//   event (untrusted). The ONLY reliable way to hand it a file is CDP's
//   `DOM.setFileInputFiles`, which sets files as if a human picked them. Proven
//   live: setFileInputFiles + click Send posts a real image; synthetic inject
//   does not. (See docs/HOW_IT_WORKS_AND_LESSONS.md.)
//
// Flow:
//   1. Map the Sendbird channel_url → Workvivo web route and open our own tab.
//   2. Wait until the composer (#chat-file-attach) is present.
//   3. Foreground the tab so React fully renders, then attach CDP.
//   4. Write the PNG to disk (CDP needs a path) via chrome.downloads(data URL).
//   5. DOM.setFileInputFiles([path]) on #chat-file-attach.
//   6. Poll for the Send button to enable, then click it.
//   7. Confirm a new upload appears; detach, delete temp file, close tab,
//      restore the previously-active tab.
//
// Never throws — always resolves to a shaped result for uniform logging/retry.

import { attach, detach, sendCdp, waitForNetworkIdle } from "./cdp.js";

const WORKVIVO_ORIGIN = "https://workvivo.walmart.com";
const TAG = "[metricshot wv-upload]";

// ── Pure helpers (unit-tested in tests/workvivo_upload.test.mjs) ────────────

/**
 * Map a Sendbird channel_url to the Workvivo chat web route.
 *   sendbird_group_channel_<ID>  →  /chat/channels/gc_<ID>
 * Verified across multiple channels 2026-07-28. Returns null if unrecognized.
 */
export function channelWebPath(channelUrl) {
  if (typeof channelUrl !== "string") return null;
  const m = channelUrl.match(/^sendbird_group_channel_(.+)$/);
  if (!m) return null;
  return `/chat/channels/gc_${m[1]}`;
}

/** Full Workvivo URL for a channel, or the generic /chat if unmappable. */
export function channelWebUrl(channelUrl) {
  const path = channelWebPath(channelUrl);
  return WORKVIVO_ORIGIN + (path || "/chat");
}

// ── In-page probes (MAIN world via CDP Runtime.evaluate) ────────────────────
// Kept as string expressions because CDP Runtime.evaluate takes source, not a
// serialized function. Each returns JSON-serializable data.

const JS_COMPOSER_READY = `(() => {
  const input = document.querySelector('#chat-file-attach');
  return { hasInput: !!input };
})()`;

const JS_SEND_STATE = `(() => {
  const b = [...document.querySelectorAll('button,[role=button]')].find(x =>
    /send/i.test((x.getAttribute('aria-label')||'') + x.className) &&
    !/attach|file|photo/i.test((x.getAttribute('aria-label')||'') + x.className));
  const pending = /\\.png|attachment/i.test(document.body.innerText);
  return { sendFound: !!b, sendEnabled: b ? !b.disabled : false, pending };
})()`;

const JS_CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button,[role=button]')].find(x =>
    /send/i.test((x.getAttribute('aria-label')||'') + x.className) &&
    !/attach|file|photo/i.test((x.getAttribute('aria-label')||'') + x.className));
  if (!b) return { clicked: false };
  b.click();
  return { clicked: true };
})()`;

/**
 * Does a request URL look like the image upload (or the message-with-file
 * create) that Workvivo fires when Send is clicked? Broad on purpose — the
 * exact backend route may vary, so we match the known media/upload/message
 * shapes and the Sendbird file-message endpoint. Excludes GET-only asset
 * fetches by matching on path keywords, not the cloudfront CDN (which is where
 * images are SERVED from, not uploaded to).
 */
function _looksLikeUpload(url) {
  if (typeof url !== "string") return false;
  return /\/(upload|media|files?|attachments?|messages)\b/i.test(url) ||
    /storage\.sendbird\.com|file\.sendbird\.com|sendbird.*\/(storage|upload)/i.test(url);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Post a PNG (base64) to a Workvivo channel via the UI composer.
 * @param {object} a
 * @param {string} a.channelUrl  Sendbird channel_url (from REST resolve).
 * @param {string} a.pngBase64   Raw base64 PNG (no data: prefix).
 * @param {string} [a.fileName]
 * @param {(name:string, extra?:object)=>void} [a.onStep]
 * @returns {Promise<{ok:boolean, errorClass?:string, error?:string}>}
 */
export async function postImageViaWorkvivoUI({ channelUrl, pngBase64, fileName, onStep } = {}) {
  const step = (name, extra) => { try { onStep?.(name, extra); } catch { /* ignore */ } };
  if (!pngBase64) return { ok: false, errorClass: "INPUT", error: "missing pngBase64" };
  if (!channelUrl) return { ok: false, errorClass: "INPUT", error: "missing channelUrl" };

  const url = channelWebUrl(channelUrl);
  const name = fileName || "metricshot.png";

  let tabId = null, downloadId = null, filePath = null, attached = false, prevActive = null;
  try {
    // 1. Stage the PNG on disk (CDP setFileInputFiles needs a path).
    step("stage-file");
    const staged = await _stagePngToDisk(pngBase64, name);
    if (!staged.ok) return { ok: false, errorClass: "STAGE_FAIL", error: staged.error };
    downloadId = staged.downloadId; filePath = staged.path;

    // 2. Open our own tab at the channel route.
    step("tab-open", { url });
    prevActive = await _currentActiveTab();
    const tab = await chrome.tabs.create({ url, active: false }).catch((e) => ({ __err: String(e?.message ?? e) }));
    if (!tab || tab.__err || !tab.id) return { ok: false, errorClass: "NO_TAB", error: `open tab: ${tab?.__err || "unknown"}` };
    tabId = tab.id;

    // 3. Foreground so React renders the composer fully.
    step("foreground");
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});

    // 4. Attach CDP + wait for the composer.
    attached = await attach(tabId);
    if (!attached) return { ok: false, errorClass: "CDP_ATTACH", error: "could not attach debugger (DevTools open?)" };
    await sendCdp(tabId, "DOM.enable", {}).catch(() => {});
    await sendCdp(tabId, "Runtime.enable", {}).catch(() => {});
    await sendCdp(tabId, "Network.enable", {}).catch(() => {});
    await sendCdp(tabId, "Page.bringToFront", {}).catch(() => {});

    step("wait-composer");
    const ready = await _pollEval(tabId, JS_COMPOSER_READY, (r) => r?.hasInput, 30_000);
    if (!ready) return { ok: false, errorClass: "UI_NO_COMPOSER", error: "chat composer (#chat-file-attach) never appeared — not signed in or wrong channel" };

    // 5. Set the file on the input node (the trusted magic).
    step("set-file");
    const doc = await sendCdp(tabId, "DOM.getDocument", { depth: -1 });
    const q = await sendCdp(tabId, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#chat-file-attach" });
    if (!q?.nodeId) return { ok: false, errorClass: "UI_NO_COMPOSER", error: "#chat-file-attach node not found" };
    await sendCdp(tabId, "DOM.setFileInputFiles", { nodeId: q.nodeId, files: [filePath] });

    // 6. Wait for Send to enable, then click.
    step("wait-send");
    const sendReady = await _pollEval(tabId, JS_SEND_STATE, (r) => r?.sendFound && r?.sendEnabled, 20_000);
    if (!sendReady) return { ok: false, errorClass: "UI_SEND_DISABLED", error: "Send button never enabled after attaching file" };
    step("click-send");
    const clicked = await _eval(tabId, JS_CLICK_SEND);
    if (!clicked?.clicked) return { ok: false, errorClass: "UI_SEND_FAIL", error: "could not click Send" };

    // 7. Confirm the upload actually COMPLETED on the network before closing.
    //    The old DOM image-count check false-positived instantly (existing
    //    channel images inflate the count) and we closed the tab mid-upload,
    //    aborting Workvivo's POST. Now we watch the network: wait for an upload
    //    request to return 2xx, then for the network to go idle, then settle.
    step("confirm");
    let uploadResp = null;
    const postResponses = []; // for debug/tuning when confirm fails
    const net = await waitForNetworkIdle(tabId, {
      idleMs: 2500,
      minWaitMs: 4000,
      timeoutMs: 45_000,
      onResponse: (r) => {
        if (r.method && r.method !== "GET") postResponses.push({ url: r.url, status: r.status, method: r.method });
        if (!uploadResp && _looksLikeUpload(r.url) && r.status >= 200 && r.status < 300) {
          uploadResp = r;
        }
      },
    });
    // Extra settle so any trailing message-create request finishes.
    await _delay(1500);

    if (!uploadResp) {
      // No clear upload response seen. Surface the POSTs we DID see so the
      // matcher can be tuned rather than silently lying about success.
      return {
        ok: false,
        errorClass: "UI_UNCONFIRMED",
        error: `clicked Send but saw no matching upload response (netIdle=${net.idle}, completed=${net.completed})`,
        debug: { postResponses: postResponses.slice(0, 12) },
      };
    }
    step("done", { uploadStatus: uploadResp.status });
    return { ok: true, path: "ui" };
  } catch (e) {
    return { ok: false, errorClass: "UI_UPLOAD_FAIL", error: String(e?.message ?? e) };
  } finally {
    if (attached && tabId != null) await detach(tabId).catch(() => {});
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    if (prevActive?.id && prevActive.id !== tabId) await chrome.tabs.update(prevActive.id, { active: true }).catch(() => {});
    if (downloadId != null) await _cleanupDownload(downloadId).catch(() => {});
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Write base64 PNG to disk via chrome.downloads (data URL) and return its path. */
async function _stagePngToDisk(pngBase64, fileName) {
  try {
    const dataUrl = "data:image/png;base64," + pngBase64;
    const safe = `metricshot_tmp_${Date.now()}_${fileName}`.replace(/[^\w.\-]/g, "_");
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename: safe, saveAs: false, conflictAction: "uniquify" });
    // Wait for the download to complete so a filesystem path exists.
    const path = await _waitDownloadPath(downloadId, 15_000);
    if (!path) return { ok: false, error: "download did not complete / no path" };
    return { ok: true, downloadId, path };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function _waitDownloadPath(downloadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
    if (item && item.state === "complete" && item.filename) return item.filename;
    if (item && item.state === "interrupted") return null;
    await _delay(300);
  }
  return null;
}

async function _cleanupDownload(downloadId) {
  // Remove the temp file from disk + the download history entry.
  await chrome.downloads.removeFile(downloadId).catch(() => {});
  await chrome.downloads.erase({ id: downloadId }).catch(() => {});
}

/** Runtime.evaluate → returnByValue. Returns the value or null. */
async function _eval(tabId, expression) {
  const r = await sendCdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).catch(() => null);
  return r?.result?.value ?? null;
}

/** Poll _eval until predicate(value) is truthy or timeout. */
async function _pollEval(tabId, expression, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await _eval(tabId, expression);
    if (predicate(v)) return true;
    await _delay(500);
  }
  return false;
}

async function _currentActiveTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t || null;
  } catch { return null; }
}

function _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
