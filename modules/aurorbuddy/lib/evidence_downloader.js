// lib/evidence_downloader.js — CCTV clip + receipt image → local disk
// ───────────────────────────────────────────────────────────────────────────
// Port of pipeline/cctv_downloader.py into the extension.
//
// VIDEO DOWNLOAD STRATEGY — passive CDP response-body capture
// ────────────────────────────────────────────────────────────
// The APPRISS CCTV viewer is a Verint HLS player. It fetches:
//   1. index.m3u8  — the playlist (tells us total segment count up-front)
//   2. segment_N.ts — MPEG-TS chunks, one per camera-event second
//
// The Verint backend rate-limits NEW requests from our service worker to
// ~120 KB/s aggregate — but it serves the player itself at full speed.
// The efficient approach (matching pipeline/cctv_downloader.py) is to
// passively capture the player's OWN responses via CDP Network.getResponseBody
// rather than issuing separate fetch() calls. We attach chrome.debugger to
// the CCTV tab, enable the Network domain, listen for loadingFinished on
// .ts URLs, and pull the already-decoded bytes straight from the browser's
// network buffer — zero extra bandwidth, full throughput.
//
// Receipts are simpler — the APPRISS viewer loads the image inline. We open
// the viewer tab, wait for render, extract the <img> src from the DOM, and
// fetch the bytes.
//
// Final layout (relative to the user's Chrome Downloads folder — Chrome
// extensions can't write elsewhere without a user prompt per file):
//
//   AurorBuddy Evidence/
//     <SuspectName>/
//       <txn_id>_clip.ts
//       <txn_id>_receipt.png
//
// If the user wants everything on Desktop, the simplest fix is
//   edge://settings → Downloads → Location → Desktop
// then the relative paths resolve there. Everything else needs a Native
// Messaging host, which is overkill.

const CCTV_BASE    = "https://wmtus.apprissretailcloud.com/video/react#/cameras?transactionId=";
const RECEIPT_BASE = "https://wmtus.apprissretailcloud.com/platform/viewer?hidechrome=true#/store/ardm/event/";

// Lives under whatever is configured as the browser's 'Downloads' folder
// in edge://settings/downloads. Chrome extensions cannot write outside
// that folder without per-file user prompts, so the cleanest way to get
// this on the Desktop is to change the default download location in
// that settings page. Otherwise the files land here relative to
// %USERPROFILE%\Downloads.
const FOLDER_ROOT = "AurorBuddyDownloads";

// ─── CDP event dispatcher (module-level singleton) ─────────────────────────────
// chrome.debugger.onEvent fires GLOBALLY for every attached target. We must
// register the listener exactly once at module load, then dispatch to
// per-tab handlers registered by each downloadCctv call. Stacking a new
// addListener() inside downloadCctv would multiply-fire on every segment.
const _cdpHandlers = new Map(); // tabId → (method, params) => void

chrome.debugger.onEvent.addListener((source, method, params) => {
  const handler = _cdpHandlers.get(source.tabId);
  if (handler) handler(method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  _cdpHandlers.delete(source.tabId);
});

// Timing — mirror cctv_downloader.py constants (expressed in ms).
const PLAYER_SETTLE_MS   = 8_000;
const RECEIPT_SETTLE_MS  = 14_000;
const SEGMENT_TIMEOUT_MS = 120_000;
const SEGMENT_GAP_MS     = 12_000;

// Windows-invalid filename chars, mirroring cctv_downloader._WIN_INVALID.
const WIN_INVALID_RE = /[<>:"/\\|?*\x00-\x1f]/g;

function safeFolderName(name) {
  const stripped = String(name ?? "").replace(WIN_INVALID_RE, "_").trim().replace(/\.+$/, "");
  return stripped.slice(0, 80) || "unknown";
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function downloadEvidence({ transactionId, suspectName, onProgress, getSegmentHeaders }) {
  if (!transactionId) throw new Error("transactionId required");

  const suspect = safeFolderName(suspectName || "unknown");
  // Files land directly under the suspect's folder. The transaction id
  // is in the filename to avoid collisions when the same suspect has
  // multiple saved transactions.
  //   <Downloads>\AurorBuddyDownloads\<SuspectName>\<txn>_clip.ts
  //   <Downloads>\AurorBuddyDownloads\<SuspectName>\<txn>_receipt.png
  const prefix = `${FOLDER_ROOT}/${suspect}/${transactionId}_`;

  onProgress?.({ phase: "start", message: `Saving to %USERPROFILE%\\Downloads\\${FOLDER_ROOT}\\${suspect}\\` });

  // Run CCTV + receipt in parallel — each manages its own tab lifecycle.
  const [cctvResult, receiptResult] = await Promise.all([
    downloadCctv(transactionId, prefix, onProgress, getSegmentHeaders).catch(err => ({ error: String(err?.message ?? err) })),
    downloadReceipt(transactionId, prefix, onProgress).catch(err => ({ error: String(err?.message ?? err) }))
  ]);

  onProgress?.({ phase: "done", cctv: cctvResult, receipt: receiptResult });
  return {
    // Relative path — chrome.downloads.download writes everything under
    // the user's configured Downloads folder, so we return just the
    // subfolder. The UI tacks on '%USERPROFILE%\\Downloads\\' once.
    folder: `${FOLDER_ROOT}\\${suspect}\\`,
    cctv:    cctvResult,
    receipt: receiptResult
  };
}

// ─── CCTV (HLS segment intercept + concat) ──────────────────────────────────

async function downloadCctv(transactionId, prefix, onProgress, _getSegmentHeaders) {
  const TAG = "[Secure-CCTV]";

  // Phase 1: capture the m3u8 playlist URL + body via CDP.
  // We no longer try to intercept .ts segments through CDP — Chrome's
  // native <video> HLS pipeline fetches them through a separate media
  // stack that never fires Network.loadingFinished. Instead we grab the
  // playlist (which DOES come through the normal network stack) and then
  // fetch segments directly from the service worker in Phase 2.
  let m3u8Url  = null;
  let m3u8Text = null;

  const pendingReqs = new Map();  // requestId → url
  const M3U8_RE     = /\.m3u8/i;

  const tab = await chrome.tabs.create({ url: "about:blank", active: false });

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");

    _cdpHandlers.set(tab.id, (method, params) => {
      if (method === "Network.requestWillBeSent") {
        pendingReqs.set(params.requestId, params.request?.url ?? "");
        return;
      }
      if (method === "Network.responseReceived") {
        pendingReqs.set(params.requestId, params.response?.url ?? params.requestId);
        return;
      }
      if (method === "Network.loadingFinished") {
        const url = pendingReqs.get(params.requestId) ?? "";
        pendingReqs.delete(params.requestId);

        // Only care about m3u8 — and only the first media playlist
        // (which has .ts lines). Skip master playlists that only list
        // bandwidth variants.
        if (!M3U8_RE.test(url) || m3u8Text) return;

        chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getResponseBody",
          { requestId: params.requestId }
        ).then(body => {
          const text = body.base64Encoded ? atob(body.body) : (body.body ?? "");
          const n    = countM3u8Segments(text);
          if (n > 0) {
            m3u8Url  = url;
            m3u8Text = text;
            console.log(`${TAG} m3u8 captured (${url}): ${n} segments`);
            onProgress?.({ phase: "cctv_playlist", expected: n });
          } else {
            console.log(`${TAG} skipping master playlist (no .ts lines): ${url}`);
          }
        }).catch(err => {
          console.warn(`${TAG} getResponseBody for m3u8 failed:`, err.message);
        });
      }
    });

    // Increase CDP buffer limits so the m3u8 body is retained.
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {
      maxTotalBufferSize:    100_000_000,
      maxResourceBufferSize:  20_000_000,
    });

    // Spoof visibilityState so the player doesn't suppress buffering.
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable", {});
    await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `
          Object.defineProperty(document, 'visibilityState', {
            get: () => 'visible', configurable: true
          });
          Object.defineProperty(document, 'hidden', {
            get: () => false, configurable: true
          });
          document.addEventListener('visibilitychange',
            e => e.stopImmediatePropagation(), true);
        `
      }
    );

    await chrome.tabs.update(tab.id, { url: `${CCTV_BASE}${transactionId}` });
    await sleep(600);
    await waitForTabLoad(tab.id, 30_000);
    await sleep(PLAYER_SETTLE_MS);
    await kickPlayer({ tabId: tab.id });

    // Wait up to 30s for the m3u8 to arrive. It typically shows up
    // within the first few seconds of the player mounting.
    const m3u8Deadline = Date.now() + 30_000;
    while (Date.now() < m3u8Deadline && !m3u8Text) {
      await sleep(300);
    }

  } finally {
    _cdpHandlers.delete(tab.id);
    chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    chrome.tabs.remove(tab.id).catch(() => {});
  }

  if (!m3u8Text) {
    return { error: "Playlist not received — camera offline, session expired, or player failed to start." };
  }

  // Phase 2: resolve segment URLs and fetch directly from the service
  // worker. host_permissions includes *.wal-mart.com/* so credentials:
  // 'include' sends the session cookies that the CCTV viewer already
  // established. No separate auth header juggling needed.
  const segUrls = extractM3u8Segments(m3u8Text, m3u8Url);
  if (segUrls.length === 0) {
    return { error: "Playlist received but contained no segments (master playlist only?)." };
  }

  console.log(`${TAG} fetching ${segUrls.length} segments via service-worker fetch`);
  const bufs      = [];
  let   totalBytes = 0;

  for (let i = 0; i < segUrls.length; i++) {
    try {
      const resp = await fetch(segUrls[i], { credentials: "include" });
      if (!resp.ok) {
        console.warn(`${TAG} segment ${i} — HTTP ${resp.status}, skipping`);
        continue;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      bufs.push(buf);
      totalBytes += buf.length;
      onProgress?.({ phase: "cctv_segment", received: bufs.length, total: segUrls.length });
      console.log(`${TAG} segment ${i + 1}/${segUrls.length} — ${buf.length.toLocaleString()} B`);
    } catch (err) {
      console.warn(`${TAG} segment ${i} fetch error: ${err.message}`);
    }
  }

  if (bufs.length === 0) {
    return { error: "All segment fetches failed — auth issue or NVR unreachable from service worker." };
  }

  // Concat in playlist order → single MPEG-TS blob.
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of bufs) { merged.set(chunk, offset); offset += chunk.length; }

  const downloadId = await downloadBytes(merged, "video/mp2t", `${prefix}clip.ts`);
  onProgress?.({ phase: "cctv_saved", downloadId, bytes: totalBytes, segments: bufs.length });
  console.log(`${TAG} saved — ${totalBytes.toLocaleString()} B, ${bufs.length} segments`);
  return { downloadId, bytes: totalBytes, segments: bufs.length };
}


async function downloadReceipt(transactionId, prefix, onProgress) {
  onProgress?.({ phase: "receipt_open" });
  const tab = await chrome.tabs.create({ url: `${RECEIPT_BASE}${transactionId}`, active: false });

  try {
    await waitForTabLoad(tab.id);
    await sleep(RECEIPT_SETTLE_MS);

    // Ask the isolated-world of the tab to extract the receipt image src.
    // Mirrors the two-strategy approach in cctv_downloader._capture_receipt.
    const [{ result: imgSrc } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Try common 'Show Receipt' toggle first.
        const buttons = document.querySelectorAll("button");
        for (const b of buttons) {
          if ((b.textContent || "").trim() === "Show Receipt") {
            b.click();
            break;
          }
        }
        const containers = [
          document.querySelector('[class*="receipt"]'),
          document.querySelector('[id*="receipt"]'),
          document.querySelector('[class*="event"]'),
          document.body
        ];
        for (const root of containers) {
          if (!root) continue;
          const imgs = [...root.querySelectorAll("img")].filter(i =>
            i.naturalWidth > 50 && i.src && !i.src.startsWith("data:image/gif"));
          if (imgs.length) return imgs[0].src;
        }
        return "";
      }
    });

    if (!imgSrc) {
      return { error: "Could not find the receipt image in the viewer — page may still be loading or session expired." };
    }

    onProgress?.({ phase: "receipt_fetch" });
    // Fetch the bytes from the tab's context so cookies go along (receipt
    // images on APPRISS are session-scoped). Return as array so it crosses
    // the message boundary cleanly.
    const [{ result: bytes } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (src) => {
        try {
          const r = await fetch(src, { credentials: "include" });
          if (!r.ok) return null;
          const buf = await r.arrayBuffer();
          return Array.from(new Uint8Array(buf));
        } catch {
          return null;
        }
      },
      args: [imgSrc]
    });

    if (!bytes || !bytes.length) {
      return { error: "Could not fetch the receipt image bytes." };
    }

    const suffix = imgSrc.toLowerCase().endsWith(".jpg") ? "jpg" : "png";
    const mime   = suffix === "jpg" ? "image/jpeg" : "image/png";
    const downloadId = await downloadBytes(new Uint8Array(bytes), mime, `${prefix}receipt.${suffix}`);
    onProgress?.({ phase: "receipt_saved", downloadId, bytes: bytes.length });
    return { downloadId, bytes: bytes.length };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ─── Blob → chrome.downloads helper ─────────────────────────────────────────
// URL.createObjectURL is available in Web Workers but NOT in MV3 service
// workers (per spec). Calling it from here throws 'URL.createObjectURL is
// not a function' — which is exactly what the analyst hit on their first
// Save of a receipt.
//
// Workaround: encode the bytes as a base64 data URL and hand that to
// chrome.downloads.download. The API accepts data URLs without any
// special blob plumbing. The chunking loop avoids the ~65535-arg limit
// on String.fromCharCode.apply when the byte array is large.
function uint8ToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    binary += String.fromCharCode.apply(null, bytes.subarray(i, end));
  }
  return btoa(binary);
}

async function downloadBytes(bytes, mime, filename) {
  const dataUrl = `data:${mime};base64,${uint8ToBase64(bytes)}`;
  return await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url:            dataUrl,
      filename,
      saveAs:         false,
      conflictAction: "uniquify"
    }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });
}

// Kick the Verint <video> element so it actually buffers the whole clip.
// Chrome throttles / pauses background-tab media playback — without
// this nudge the player fetches only seg 1 (metadata pre-roll) and
// sits idle, which is what v0.1.44 hit. We try in waves: locate the
// element (may be behind shadow DOM or iframes), mute it, crank the
// playback rate, and call play(). The tab is muted so there's no
// audio regardless of the playbackRate.
async function kickPlayer(target) {
  const TAG = "[Secure-CCTV]";
  // Try for up to 10s to find the video element — the React player
  // mounts it a beat after the m3u8 is fetched.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        function findVideo(root) {
          const v = root.querySelector?.("video");
          if (v) return v;
          // walk shadow roots
          const all = root.querySelectorAll?.("*") || [];
          for (const el of all) {
            if (el.shadowRoot) {
              const found = findVideo(el.shadowRoot);
              if (found) return found;
            }
          }
          // walk iframes
          const frames = root.querySelectorAll?.("iframe") || [];
          for (const f of frames) {
            try {
              const found = findVideo(f.contentDocument);
              if (found) return found;
            } catch {}
          }
          return null;
        }
        const video = findVideo(document);
        if (!video) return { found: false };
        video.muted = true;
        video.autoplay = true;
        video.playbackRate = 16;
        const duration = video.duration;
        // Seek into the clip so the player loads buffer ahead
        try { video.currentTime = 0.1; } catch {}
        const p = video.play();
        const ok = p && typeof p.then === "function"
          ? p.then(() => "played").catch(e => "play-rejected:" + (e?.name || "?"))
          : "no-promise";
        return {
          found: true,
          duration: Number.isFinite(duration) ? duration : null,
          readyState: video.readyState,
          paused: video.paused,
          playResult: p ? "pending" : "sync"
        };
      })()`,
      returnByValue: true
    });
    const r = result?.value;
    if (r?.found) {
      console.log(`${TAG} kickPlayer: found video (duration=${r.duration}s, readyState=${r.readyState}, paused=${r.paused}) — forcing 16x playback`);
      return;
    }
    await sleep(500);
  }
  console.warn(`${TAG} kickPlayer: no video element found after 10s`);
}

// ─── Tab helpers ────────────────────────────────────────────────────────────

async function waitForTabLoad(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── m3u8 helpers ───────────────────────────────────────────────────────────

function countM3u8Segments(text) {
  let n = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.trim().endsWith(".ts")) n++;
  }
  return n;
}

// Resolve all segment paths to absolute URLs using the playlist's own URL
// as the base. Handles both relative paths (segment_0.ts) and absolute
// URLs (https://...) that some Verint builds embed in the playlist.
function extractM3u8Segments(text, m3u8Url) {
  const base = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
  const urls = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    urls.push(t.startsWith("http") ? t : base + t);
  }
  return urls;
}

