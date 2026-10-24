// modules/compshop/lib/barcode.js
//
// The Comp Shop report's "WM GTIN" is the item's GTIN WITH its check digit
// and WITHOUT leading zeros (verified 2026-10-23 on store 1458):
//   33383530505    → UPC-A 033383530505   (3 lb bag, check digit 5)
//   651511009      → UPC-A 000651511009
//   5397005022034  → EAN-13
//   40112 / 940115 → PLU 4011 / organic 94011 (+ check digit)
// Me@ Comp Shop accepts a PLU typed in (4011 worked for bananas), so PLU
// items show the PLU in large type as well as the padded UPC-A barcode.
//
// Pure: no DOM, no chrome.*. The barcode comes back as an SVG string.

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const G = R.map((p) => [...p].reverse().join(""));
// EAN-13: the first digit picks odd/even parity for the left six.
const PARITY = ["LLLLLL", "LLGLGL", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** GS1 check digit for a digit string WITHOUT its check digit. */
export function checkDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += Number(body[i]) * w;
  return String((10 - (sum % 10)) % 10);
}

export const validGtin = (g) => /^\d{8,14}$/.test(g) && checkDigit(g.slice(0, -1)) === g.slice(-1);

/**
 * Normalise a report GTIN.
 * @returns {{ gtin, kind: "upc"|"ean"|"bad", code, plu, searchKey }}
 *   code      digits the barcode encodes (12 for UPC-A, 13 for EAN-13)
 *   plu       produce look-up code when the item is sold loose, else null
 *   searchKey what walmart.com search matches: GTIN without its check digit,
 *             without leading zeros ("3338353050" finds the 10 lb russets;
 *             the full GTIN finds nothing)
 */
export function parseGtin(raw) {
  let g = String(raw ?? "").replace(/\D/g, "").replace(/^0+(?=\d{13})/, "");
  if (!g) return { gtin: "", kind: "bad", code: "", plu: null, searchKey: "" };
  const padded = g.length <= 12 ? g.padStart(12, "0") : g.padStart(13, "0");
  const ok = validGtin(padded);
  let plu = null;
  if (ok && /^[34]\d{4}$/.test(g)) plu = g.slice(0, 4);
  else if (ok && /^9[34]\d{4}$/.test(g)) plu = g.slice(0, 5);
  let kind = "bad", code = "";
  if (ok && padded.length === 12) { kind = "upc"; code = padded; }
  else if (ok && padded.length === 13) {
    if (padded[0] === "0") { kind = "upc"; code = padded.slice(1); } else { kind = "ean"; code = padded; }
  }
  return { gtin: g, kind, code, plu, searchKey: ok ? padded.slice(0, -1).replace(/^0+/, "") : "" };
}

function bitsFor(kind, code) {
  if (kind === "upc") {
    let b = "101";
    for (let i = 0; i < 6; i++) b += L[+code[i]];
    b += "01010";
    for (let i = 6; i < 12; i++) b += R[+code[i]];
    return b + "101";
  }
  const par = PARITY[+code[0]];
  let b = "101";
  for (let i = 1; i <= 6; i++) b += (par[i - 1] === "L" ? L : G)[+code[i]];
  b += "01010";
  for (let i = 7; i <= 12; i++) b += R[+code[i]];
  return b + "101";
}

/**
 * SVG barcode for a parsed GTIN, or "" when it can't be encoded.
 * Guard bars run long; the human-readable digits sit underneath.
 */
export function barcodeSvg(parsed, { module = 2, height = 64 } = {}) {
  if (!parsed || (parsed.kind !== "upc" && parsed.kind !== "ean")) return "";
  const bits = bitsFor(parsed.kind, parsed.code);
  const quiet = 10 * module;
  const width = quiet * 2 + bits.length * module;
  const guard = (i) => i < 3 || (i >= 45 && i < 50) || i >= bits.length - 3;
  let bars = "";
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== "1") continue;
    let j = i;
    while (j + 1 < bits.length && bits[j + 1] === "1" && guard(j + 1) === guard(i)) j++;
    bars += `<rect x="${quiet + i * module}" y="0" width="${(j - i + 1) * module}" height="${guard(i) ? height + 8 : height}"/>`;
    i = j;
  }
  const c = parsed.code;
  const text = parsed.kind === "upc"
    ? `${c[0]} ${c.slice(1, 6)} ${c.slice(6, 11)} ${c[11]}`
    : `${c[0]} ${c.slice(1, 7)} ${c.slice(7)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + 24}" width="${width}" height="${height + 24}" role="img" aria-label="Barcode ${c}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars}</g>` +
    `<text x="${width / 2}" y="${height + 21}" font-family="monospace" font-size="14" text-anchor="middle" fill="#000">${text}</text></svg>`;
}
