// modules/costinventory/lib/xlsx.js
//
// Export to the store's own Cost-Inventory-Calculator-Worksheet.xlsx.
//
// The workbook is PATCHED, not rebuilt: the real file ships in templates/ and
// this writes values into the 25 input cells, leaving every label, border,
// colour and formula exactly as the store's copy has them. Rebuilding from
// scratch would have meant re-deriving the layout and losing the formatting
// that makes it recognisable to whoever receives it.
//
// An .xlsx is a zip, so this needs both halves. Reading uses the platform's
// DecompressionStream("deflate-raw"); writing emits STORED (uncompressed)
// entries, which is a legal zip that Excel opens happily and which avoids
// pulling in a deflate implementation. The file grows to roughly twice the
// original — about 30 KB — which is nothing for a worksheet.
//
// Formula cells keep their formulas but have their CACHED values stripped, and
// workbook.xml is marked fullCalcOnLoad, so Excel recalculates on open instead
// of showing the template's stale zeros.

const SHEET_PATH    = "xl/worksheets/sheet1.xml";
const WORKBOOK_PATH = "xl/workbook.xml";

/**
 * @param templateBytes ArrayBuffer of the shipped template
 * @param cells         { "C7": 1234.56, "C3": "1458", "E3": "2026-09-22", ... }
 *                      numbers are written as numbers, strings as inline text
 * @returns Uint8Array of the patched workbook
 */
export async function fillWorkbook(templateBytes, cells) {
  const entries = await readZip(templateBytes);

  const sheet = entries.find((e) => e.name === SHEET_PATH);
  if (!sheet) throw new Error("template is missing " + SHEET_PATH);
  sheet.data = encode(patchSheet(decode(sheet.data), cells));

  const workbook = entries.find((e) => e.name === WORKBOOK_PATH);
  if (workbook) workbook.data = encode(forceRecalc(decode(workbook.data)));

  return writeZip(entries);
}

// ─── sheet XML patching ───────────────────────────────────────────────────

export function patchSheet(xml, cells) {
  let out = xml;

  for (const [ref, value] of Object.entries(cells)) {
    if (value === undefined || value === null || value === "") continue;
    out = writeCell(out, ref, value);
  }

  // Drop cached results so Excel recomputes rather than showing the
  // template's zeros next to our freshly written inputs.
  out = out.replace(/(<f[^>]*>[\s\S]*?<\/f>)\s*<v>[\s\S]*?<\/v>/g, "$1");
  out = out.replace(/(<f[^>]*\/>)\s*<v>[\s\S]*?<\/v>/g, "$1");

  return out;
}

function writeCell(xml, ref, value) {
  const isNumber = typeof value === "number" && Number.isFinite(value);
  const row = Number(/\d+$/.exec(ref)?.[0]);
  if (!row) throw new Error("bad cell ref " + ref);

  // Keep the template's style index so the cell stays formatted as currency,
  // date or text exactly as it was.
  const existing = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)').exec(xml);
  const styleAttr = existing ? (/ s="\d+"/.exec(existing[1])?.[0] ?? "") : "";

  const body = isNumber
    ? '<v>' + value + '</v>'
    : '<is><t xml:space="preserve">' + escapeXml(String(value)) + "</t></is>";
  const typeAttr = isNumber ? "" : ' t="inlineStr"';
  const cell = '<c r="' + ref + '"' + styleAttr + typeAttr + ">" + body + "</c>";

  if (existing) return xml.replace(existing[0], cell);
  return insertCell(xml, ref, row, cell);
}

/** A cell the template left out entirely still has to land in column order. */
function insertCell(xml, ref, row, cell) {
  const rowRe = new RegExp('(<row[^>]*r="' + row + '"[^>]*>)([\\s\\S]*?)(</row>)');
  const m = rowRe.exec(xml);
  if (!m) throw new Error("row " + row + " not found in sheet — template changed?");

  const col = colIndex(ref);
  const cells = [...m[2].matchAll(/<c r="([A-Z]+\d+)"[\s\S]*?(?:\/>|<\/c>)/g)];
  const after = cells.find((c) => colIndex(c[1]) > col);

  const inner = after
    ? m[2].replace(after[0], cell + after[0])
    : m[2] + cell;

  return xml.replace(m[0], m[1] + inner + m[3]);
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

function forceRecalc(xml) {
  if (/<calcPr[^>]*\/>/.test(xml)) {
    return xml.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>');
  }
  return xml.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * "2026-09-22" -> 46287, the serial Excel stores dates as.
 *
 * The worksheet's date cell (E3) is styled with built-in numFmt 14 (m/d/yyyy),
 * so writing text there would give a date-shaped string that does not sort or
 * subtract. Epoch is 1899-12-30, which absorbs Excel's fictional 1900 leap day
 * for every date this tool will ever write.
 */
export function excelDateSerial(isoDate) {
  const ms = new Date(isoDate + "T00:00:00Z") - new Date("1899-12-30T00:00:00Z");
  return Math.round(ms / 86400000);
}

// ─── zip ──────────────────────────────────────────────────────────────────

async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of central directory: scan backwards, the comment is almost always empty.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt central directory at " + p);

    const method     = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen    = view.getUint16(p + 28, true);
    const extraLen   = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff   = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // The local header's extra field can differ in length from the central one.
    const lNameLen  = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compressed);

    entries.push({ name, data: method === 8 ? await inflateRaw(raw) : raw.slice() });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function writeZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = encoder.encode(e.name);
    const crc = crc32(e.data);

    const local = new Uint8Array(30 + name.length + e.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // STORED
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(e.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);            // STORED
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals)   { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decode(bytes) { return new TextDecoder().decode(bytes); }
function encode(text)  { return new TextEncoder().encode(text); }
