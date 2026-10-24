// modules/digitaldashboard/lib/pair_qr.js
//
// The phone-pairing QR: the one-time code as a gifcompanion:// link, which
// GIF Companion's scanner (and its intent filter, for a stock camera app) reads.
// Pure apart from the vendored encoder.

import { create } from "../vendor/qrcode.min.js";

export const pairLink = (code) => `gifcompanion://pair?code=${encodeURIComponent(code)}`;

/** SVG markup (black on white, 4-module quiet zone) for `text`. */
export function qrSvg(text, { px = 6 } = {}) {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const n = modules.size, q = 4, size = (n + q * 2) * px;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (modules.get(r, c)) d += `M${(c + q) * px} ${(r + q) * px}h${px}v${px}h-${px}z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Pairing QR code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
