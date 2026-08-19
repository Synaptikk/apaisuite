// modules/metricshot/lib/rasterize.js
//
// SVG string -> base64 PNG, via a single reused offscreen document.
//
// Replaces the CDP Page.captureScreenshot path that cost the extension the
// "debugger" permission. The offscreen document is created on first use and
// left alive; Chrome allows exactly one per extension, so creation races have
// to be serialised or the second call throws.

const OFFSCREEN_PATH = "modules/metricshot/offscreen.html";
const RASTER_TIMEOUT_MS = 20_000;

// Chrome permits ONE offscreen document per extension. Two concurrent
// captures (a scheduled run and a manual preview) would both see "not
// created" and both call createDocument, and the loser throws. Holding the
// in-flight promise makes the second caller await the first.
let _creating = null;

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (_creating) return _creating;
  _creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"], // decoding an SVG blob into canvas pixels
      justification:
        "Rasterise the locally-rendered metric chart to PNG for posting; " +
        "service workers cannot decode SVG.",
    })
    .finally(() => { _creating = null; });
  return _creating;
}

async function hasOffscreen() {
  // getContexts is the supported check (Chrome 116+); clients.matchAll is the
  // older fallback and is what runs if this ever ships to an older browser.
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return ctx.length > 0;
  }
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const matched = await clients.matchAll();
  return matched.some((c) => c.url === url);
}

/**
 * @param {string} svg     complete <svg>…</svg> markup
 * @param {object} opts    { width, height, scale }
 * @returns {Promise<{ok: true, pngBase64: string} | {ok: false, reason: string}>}
 *          Never throws — the caller treats a failed render like a failed
 *          capture, same as the CDP path it replaces.
 */
export async function svgToPngBase64(svg, { width, height, scale = 2 } = {}) {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, reason: `offscreen document unavailable: ${e?.message ?? e}` };
  }

  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage({ target: "metricshot-offscreen", svg, width, height, scale }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`rasterise timed out after ${RASTER_TIMEOUT_MS / 1000}s`)), RASTER_TIMEOUT_MS),
      ),
    ]);
    if (!reply?.ok) return { ok: false, reason: reply?.error || "rasteriser returned no image" };
    if (!reply.pngBase64) return { ok: false, reason: "rasteriser returned an empty image" };
    return { ok: true, pngBase64: reply.pngBase64 };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/** Tear the document down — used by tests and on module disable. */
export async function closeRasterizer() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch {}
}
