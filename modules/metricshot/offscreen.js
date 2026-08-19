// modules/metricshot/offscreen.js
//
// Runs inside the offscreen document created by lib/rasterize.js.
//
// Protocol: receives { target: "metricshot-offscreen", svg, width, height,
// scale } and replies { ok, pngBase64 } | { ok: false, error }.
//
// Why an offscreen document rather than the service worker: decoding an SVG
// needs an image decoder that workers don't expose for SVG, so the SW cannot
// turn vizpick's chart markup into pixels on its own.

const MAX_SIDE = 4096; // guard against a runaway scale blowing up memory

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "metricshot-offscreen") return false;
  rasterize(msg)
    .then((pngBase64) => sendResponse({ ok: true, pngBase64 }))
    .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
  return true; // async response
});

async function rasterize({ svg, width, height, scale = 2 }) {
  if (typeof svg !== "string" || !svg.trim()) throw new Error("no svg supplied");

  const w = Math.min(MAX_SIDE, Math.round(width * scale));
  const h = Math.min(MAX_SIDE, Math.round(height * scale));
  if (!(w > 0 && h > 0)) throw new Error(`bad raster size ${w}x${h}`);

  // Blob URL rather than a data: URL — a data: URL of a large SVG can exceed
  // the URL length the image decoder accepts, and blob: has no such limit.
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // The SVG has no background of its own; Sendbird renders PNGs on white in
    // some clients and dark in others, so paint it explicitly.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await toBase64(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // An SVG that references an external font or image would hang here, so
    // fail loudly rather than let the SW watchdog take the blame.
    const t = setTimeout(() => reject(new Error("svg image load timed out after 10s")), 10_000);
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); reject(new Error("svg failed to decode")); };
    img.src = url;
  });
}

function toBase64(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b) return reject(new Error("canvas.toBlob returned null"));
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1]); // strip data: prefix
      fr.onerror = () => reject(new Error("failed to read PNG blob"));
      fr.readAsDataURL(b);
    }, "image/png");
  });
}
