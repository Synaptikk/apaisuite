// modules/metricshot/lib/validate.js
//
// Screenshot validation + page-authenticity checks. Runs entirely in the SW
// (or Node for tests) — no chrome.* dependencies for the pure functions.

// Login/access-denied page sniff — reused from shared/auth.js:105-106 style.
export const LOGIN_TITLE_RE =
  /sign[- ]?in|log[- ]?in|access\s*denied|not\s*authorized|session\s*expired|pingfederate|okta|onelogin|saml/i;

// PNG magic number: 89 50 4E 47 0D 0A 1A 0A
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * Structural + content validation of a captured PNG.
 *
 * @param {Uint8Array} bytes  Raw PNG bytes.
 * @param {object} [opts]
 * @param {number} [opts.minBytes=5_000]     Reject smaller than this.
 * @param {number} [opts.minWidth=100]
 * @param {number} [opts.minHeight=100]
 * @returns {{ok:boolean, reason?:string, width?:number, height?:number}}
 */
export function validatePngBytes(bytes, opts = {}) {
  const minBytes  = opts.minBytes  ?? 5_000;
  const minWidth  = opts.minWidth  ?? 100;
  const minHeight = opts.minHeight ?? 100;

  if (!bytes || !bytes.length) return { ok: false, reason: "empty bytes" };
  if (bytes.length < minBytes) return { ok: false, reason: `too small (${bytes.length} bytes)` };
  if (!hasPngSignature(bytes)) return { ok: false, reason: "not a PNG (missing signature)" };

  const dims = readPngIHDR(bytes);
  if (!dims)               return { ok: false, reason: "malformed PNG (no IHDR)" };
  if (dims.width  < minWidth ) return { ok: false, reason: `too narrow (${dims.width}px)` };
  if (dims.height < minHeight) return { ok: false, reason: `too short (${dims.height}px)` };

  return { ok: true, width: dims.width, height: dims.height };
}

function hasPngSignature(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

// Read width/height from the IHDR chunk at bytes 16..24 (after the 8-byte
// signature + 8-byte IHDR header).
function readPngIHDR(bytes) {
  if (bytes.length < 24) return null;
  // Signature (8) + chunk length (4) + type "IHDR" (4) + width (4) + height (4)
  // Bytes 12..16 should be 0x49 0x48 0x44 0x52 ("IHDR")
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width  = readUInt32BE(bytes, 16);
  const height = readUInt32BE(bytes, 20);
  return { width, height };
}

function readUInt32BE(bytes, offset) {
  return (bytes[offset]     * 0x1000000) +
         (bytes[offset + 1] * 0x10000)   +
         (bytes[offset + 2] * 0x100)     +
         (bytes[offset + 3]);
}

/**
 * Given a snapshot of a page's title + first heading text, decide whether the
 * page landed on a login/SSO/access-denied surface. Called before capture so
 * we don't publish a misleading screenshot.
 */
export function looksLikeAuthWall({ title, headings }) {
  const parts = [title, ...(headings || [])].map((s) => String(s || "")).filter(Boolean);
  return parts.some((s) => LOGIN_TITLE_RE.test(s));
}

/**
 * Given a base64-encoded PNG, decode to bytes.
 */
export function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/^data:image\/png;base64,/, "");
  // atob returns a binary string. In SW + Node 18+ this works.
  const bin = typeof atob === "function"
    ? atob(clean)
    : Buffer.from(clean, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
