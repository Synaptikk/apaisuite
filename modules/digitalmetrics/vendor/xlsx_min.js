// modules/digitalmetrics/vendor/xlsx_min.js
//
// VENDORED from modules/metricshot/lib/sources/xlsx_min.js — copied rather
// than imported because the module contract keeps modules self-contained.
// If a parsing bug is fixed in either copy, port it to the other.
//
// Chosen over SheetJS deliberately: SheetJS is 881KB and would have to be
// vendored too (MV3 forbids the CDN script the donor used). This is 7.5KB and
// has no dependencies.
//
// Minimal, dependency-free .xlsx reader — just enough to turn Tableau's
// crosstab-export spreadsheet into rows of strings. An .xlsx file is a ZIP
// archive of XML parts; we only need three of them:
//
//   xl/sharedStrings.xml      → the string table (cells reference it by index)
//   xl/worksheets/sheet1.xml  → the cell grid (r="A1" refs + t="s" type flags)
//   (we ignore styles, formats, charts, everything else)
//
// We decompress ZIP entries with the platform's built-in DecompressionStream
// ("deflate-raw") — no JSZip, no npm, no bloat. Store-mode (uncompressed)
// entries are handled too. This is intentionally NOT a general-purpose ZIP
// or XLSX library; it decodes exactly what Tableau emits and nothing more.
//
// Pure: no chrome.*/DOM. Input is a Uint8Array (the .xlsx bytes), output is
// a 2-D array of row arrays of string cell values.

/**
 * Parse .xlsx bytes into rows.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ ok: boolean, rows?: string[][], reason?: string }>}
 */
export async function parseXlsx(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
    return { ok: false, reason: "not a byte array" };
  }
  // ZIP local-file signature "PK\x03\x04".
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return { ok: false, reason: "not a ZIP/xlsx (bad magic)" };
  }

  let entries;
  try { entries = _readZipEntries(bytes); }
  catch (e) { return { ok: false, reason: `zip read failed: ${e?.message ?? e}` }; }

  const sharedXml = await _entryText(entries, "xl/sharedStrings.xml");
  const shared = sharedXml ? _parseSharedStrings(sharedXml) : [];

  // Find the first worksheet part. Tableau exports a single sheet, usually
  // sheet1.xml, but don't hard-code — pick the lowest-numbered sheet part.
  const sheetName = _firstSheetPartName(entries);
  if (!sheetName) return { ok: false, reason: "no worksheet part found" };
  const sheetXml = await _entryText(entries, sheetName);
  if (!sheetXml) return { ok: false, reason: `could not read ${sheetName}` };

  const rows = _parseSheet(sheetXml, shared);
  return { ok: true, rows };
}

/**
 * Parse EVERY worksheet, not just the first.
 *
 * ADDED FOR digitalmetrics (not in the metricshot original). The Daily Board
 * workbook can carry one sheet per day, and reading only sheet1 would import
 * one day and silently discard the rest — the kind of data loss that looks
 * like a successful import.
 *
 * @returns {Promise<{ ok: boolean, sheets?: { name: string, rows: string[][] }[], reason?: string }>}
 */
export async function parseXlsxAllSheets(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
    return { ok: false, reason: "not a byte array" };
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return { ok: false, reason: "not a ZIP/xlsx (bad magic)" };
  }

  let entries;
  try { entries = _readZipEntries(bytes); }
  catch (e) { return { ok: false, reason: `zip read failed: ${e?.message ?? e}` }; }

  const sharedXml = await _entryText(entries, "xl/sharedStrings.xml");
  const shared = sharedXml ? _parseSharedStrings(sharedXml) : [];

  const names = _allSheetPartNames(entries);
  if (!names.length) return { ok: false, reason: "no worksheet part found" };

  const sheets = [];
  for (const name of names) {
    const xml = await _entryText(entries, name);
    if (!xml) continue;
    sheets.push({ name, rows: _parseSheet(xml, shared) });
  }
  if (!sheets.length) return { ok: false, reason: "no readable worksheets" };
  return { ok: true, sheets };
}

// ── ZIP central-directory walk ────────────────────────────────────────────

function _readZipEntries(buf) {
  // Locate End Of Central Directory (EOCD): signature 0x06054b50, scanned
  // from the tail (comment is usually empty so it's near the end).
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD not found");

  const cdCount  = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // central dir header
    const method    = dv.getUint16(p + 10, true);
    const compSize  = dv.getUint32(p + 20, true);
    const nameLen   = dv.getUint16(p + 28, true);
    const extraLen  = dv.getUint16(p + 30, true);
    const commLen   = dv.getUint16(p + 32, true);
    const localOff  = dv.getUint32(p + 42, true);
    const name = _utf8(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commLen;
  }
  return { buf, dv, entries };
}

async function _entryText(zip, name) {
  const meta = zip.entries.get(name);
  if (!meta) return null;
  const { buf, dv } = zip;
  // Read the local file header to find the true data start (its name/extra
  // lengths can differ from the central directory's).
  const lh = meta.localOff;
  if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error("bad local header");
  const nameLen  = dv.getUint16(lh + 26, true);
  const extraLen = dv.getUint16(lh + 28, true);
  const dataStart = lh + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + meta.compSize);

  if (meta.method === 0) return _utf8(comp);          // stored
  if (meta.method === 8) return _utf8(await _inflateRaw(comp)); // deflate
  throw new Error(`unsupported zip method ${meta.method}`);
}

async function _inflateRaw(compBytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(compBytes).body.pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

// ── XML mini-parsers (regex-based; the XLSX subset is simple + regular) ─────

function _parseSharedStrings(xml) {
  // Each <si> is one shared string; text lives in <t>…</t> (possibly split
  // across multiple <r><t> runs for rich text — concatenate them).
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) != null) {
    const inner = m[1];
    let text = "";
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(inner)) != null) text += _unescapeXml(tm[1]);
    out.push(text);
  }
  return out;
}

function _allSheetPartNames(zip) {
  return [...zip.entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => _sheetNum(a) - _sheetNum(b));
}

function _firstSheetPartName(zip) {
  const names = [...zip.entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => _sheetNum(a) - _sheetNum(b));
  return names[0] || null;
}
function _sheetNum(n) {
  const m = /sheet(\d+)\.xml$/.exec(n);
  return m ? Number(m[1]) : 1e9;
}

function _parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) != null) {
    const rowXml = rm[1];
    const cells = [];
    const cRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rowXml)) != null) {
      const attrs = cm[1] || "";
      const body  = cm[2] || "";
      const ref   = /r="([A-Z]+)\d+"/.exec(attrs);
      const type  = /t="([^"]+)"/.exec(attrs);
      const colIdx = ref ? _colToIndex(ref[1]) : cells.length;
      let value = "";
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (type && type[1] === "s") {
        // shared-string index
        const idx = vMatch ? Number(vMatch[1]) : -1;
        value = idx >= 0 && idx < shared.length ? shared[idx] : "";
      } else if (type && type[1] === "inlineStr") {
        const tMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = tMatch ? _unescapeXml(tMatch[1]) : "";
      } else {
        value = vMatch ? _unescapeXml(vMatch[1]) : "";
      }
      cells[colIdx] = value;
    }
    // Normalize holes to empty strings.
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}

function _colToIndex(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n - 1;
}

// ── small utils ────────────────────────────────────────────────────────────

function _utf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}
function _unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // must be last
}
