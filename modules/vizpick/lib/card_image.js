// modules/vizpick/lib/card_image.js
//
// Turn a report page from card_report.js into a PNG, so Email can carry the
// same picture the printout shows. A mailto: body is plain text and cannot
// hold an attachment, so the image goes on the clipboard and the user pastes
// it into the draft.
//
// How: the report's <style> + body are laid out in an off-screen shadow root
// (to measure height without leaking styles into the shell), serialized as
// XHTML inside an SVG <foreignObject>, decoded as an image and drawn onto a
// canvas. No libraries; the report has no external images or fonts, which is
// what keeps the canvas untainted.

const MAX_CANVAS_PX = 16000;   // Chrome's per-side canvas ceiling is ~32k; stay well under

/**
 * @param {string} html  Full document from buildPerformanceHtml / buildPickListHtml.
 * @param {object} [opts] { width (CSS px, default 816 = 8.5in), scale (default 2) }
 * @returns {Promise<Blob>} image/png
 */
export async function reportHtmlToPng(html, opts = {}) {
  const { width = 816, scale = 2 } = opts;
  const doc = new DOMParser().parseFromString(html, "text/html");
  // The page's `body { margin: .5in }` rule becomes the wrapper's padding.
  const css = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n")
    .replace(/(^|[\s}])body\s*\{/g, "$1.rpt {")
    + `\n.rpt { margin: 0 !important; padding: 0.4in; background: #fff; box-sizing: border-box; width: ${width}px; }`;

  const hostEl = document.createElement("div");
  hostEl.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;pointer-events:none;`;
  const root = hostEl.attachShadow({ mode: "open" });
  const wrap = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = css;
  const rpt = document.createElement("div");
  rpt.className = "rpt";
  rpt.innerHTML = doc.body.innerHTML;
  wrap.append(style, rpt);
  root.append(wrap);
  document.body.append(hostEl);
  let height;
  let xhtml;
  try {
    height = Math.ceil(rpt.getBoundingClientRect().height) || 400;
    xhtml = new XMLSerializer().serializeToString(wrap);
  } finally {
    hostEl.remove();
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();

  const s = Math.max(0.5, Math.min(scale, MAX_CANVAS_PX / width, MAX_CANVAS_PX / height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * s);
  canvas.height = Math.round(height * s);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(s, s);
  ctx.drawImage(img, 0, 0, width, height);
  return await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode the report image"))), "image/png"));
}
