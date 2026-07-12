// modules/digitallocks/lib/xlsx.js
//
// Minimal in-house XLSX (OOXML) reader. No third-party deps.
//
// An .xlsx file is a ZIP archive containing XML parts. For our daily AP
// review we only need:
//   - xl/sharedStrings.xml   shared string table (most cell values)
//   - xl/worksheets/sheet1.xml   the first worksheet
// We ignore styles, formulas, multiple sheets, drawings, charts, themes.
//
// Pipeline:
//   1. readXlsxFile(File|ArrayBuffer)
//      → unzipMembers(buffer)            ZIP central-directory walk
//      → DecompressionStream("deflate-raw") on each compressed member
//      → returns Map<filename, Uint8Array>
//   2. parseSharedStrings(xml)          returns string[]
//   3. parseSheet(xml, sst)             returns row dicts keyed by header row
//
// Browser support: DecompressionStream("deflate-raw") shipped in Chrome 103
// and Edge 103. APAISuite requires Chrome >= 120 (manifest.json), so this is
// safe.
//
// Limitations (intentional, for V1):
//   - Stored (uncompressed) ZIP entries supported; deflate supported; other
//     compression methods (deflate64, bzip2) rejected with a clear error.
//   - ZIP64 extensions not supported. Power BI exports are kilobytes to a
//     few MB — well under the 4 GB ZIP32 ceiling.
//   - Inline strings (<c t="inlineStr">) and boolean cells are supported.
//     Formula results are read from <v>, formula itself ignored.
//   - Date cells: Excel stores dates as serial numbers. Whether a numeric
//     cell is a date depends on its style's format index, which lives in
//     styles.xml + we don't parse that. The Power BI export observed for
//     this module stores Event_time as a string ("2026-05-13 09:02:02.000"),
//     so we skip Excel date serial decoding in V1. parseLockEvents.js
//     handles the string form. If a future export gives us serial dates,
//     extend here with `excelSerialToDate()`.

// ── Public entry point ──────────────────────────────────────────────

/**
 * Read an .xlsx file and return the first sheet as { headers, rows }.
 * @param {File|ArrayBuffer|Uint8Array} input
 * @returns {Promise<{headers: string[], rows: object[]}>}
 */
export async function readXlsxFile(input) {
  const buf = await toArrayBuffer(input);
  const members = await unzipMembers(buf);

  const sstBytes   = members.get("xl/sharedStrings.xml");
  const sheetBytes = members.get("xl/worksheets/sheet1.xml")
                  ?? members.get("xl/worksheets/Sheet1.xml");
  if (!sheetBytes) {
    throw new Error("xlsx: xl/worksheets/sheet1.xml missing from archive (is this a valid Excel file?)");
  }

  const sst   = sstBytes ? parseSharedStrings(utf8Decode(sstBytes)) : [];
  const sheet = parseSheet(utf8Decode(sheetBytes), sst);

  return sheet;
}

// ── ZIP central-directory walk ──────────────────────────────────────
//
// ZIP format: data + central directory + end-of-central-directory record.
// We seek backwards from EOF for the EOCD signature (0x06054B50), parse it
// to find the offset of the central directory, walk each entry, and
// extract its compressed bytes from the local file header location.

const SIG_EOCD = 0x06054b50;
const SIG_CDH  = 0x02014b50;
const SIG_LFH  = 0x04034b50;
const MAX_EOCD_SCAN = 65557; // EOCD record is at most this far from EOF (22 fixed + 65535 comment).

async function unzipMembers(buf) {
  const view = new DataView(buf);
  const u8   = new Uint8Array(buf);

  // Locate EOCD by scanning backwards for the signature.
  const start = Math.max(0, view.byteLength - MAX_EOCD_SCAN);
  let eocdOff = -1;
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error("xlsx: ZIP end-of-central-directory not found");

  // EOCD: [sig(4)][diskNo(2)][diskCD(2)][cdEntriesThisDisk(2)][cdEntriesTotal(2)]
  //       [cdSize(4)][cdOffset(4)][commentLen(2)]
  const cdOffset  = view.getUint32(eocdOff + 16, true);
  const cdEntries = view.getUint16(eocdOff + 10, true);

  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(p, true) !== SIG_CDH) {
      throw new Error(`xlsx: bad central-directory header at ${p}`);
    }
    // Central Directory Header layout (only fields we need):
    //   +10  compression method     u16
    //   +20  compressed size        u32
    //   +24  uncompressed size      u32
    //   +28  filename length        u16
    //   +30  extra field length     u16
    //   +32  comment length         u16
    //   +42  local-header offset    u32
    //   +46  filename               variable
    const method     = view.getUint16(p + 10, true);
    const compSize   = view.getUint32(p + 20, true);
    const nameLen    = view.getUint16(p + 28, true);
    const extraLen   = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff   = view.getUint32(p + 42, true);
    const nameBytes  = u8.subarray(p + 46, p + 46 + nameLen);
    const name       = utf8Decode(nameBytes);

    // Hop to the local-file header to read its name+extra lengths so we can
    // compute where the actual file data starts. CD's compSize is the
    // authoritative one; we don't trust the LFH's (zip writers sometimes
    // zero it and use a data descriptor instead).
    if (view.getUint32(localOff, true) !== SIG_LFH) {
      throw new Error(`xlsx: bad local-file-header at ${localOff} for ${name}`);
    }
    const lfhNameLen  = view.getUint16(localOff + 26, true);
    const lfhExtraLen = view.getUint16(localOff + 28, true);
    const dataStart   = localOff + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd     = dataStart + compSize;
    const compBytes   = u8.subarray(dataStart, dataEnd);

    let raw;
    if (method === 0) {
      raw = compBytes;
    } else if (method === 8) {
      raw = await inflateRaw(compBytes);
    } else {
      throw new Error(`xlsx: unsupported compression method ${method} for ${name}`);
    }
    out.set(name, raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  // DecompressionStream("deflate-raw") accepts raw DEFLATE (no zlib wrapper),
  // which is what ZIP stores. Available in Chrome >= 103.
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  ));
  const ab = await stream.arrayBuffer();
  return new Uint8Array(ab);
}

// ── XML parsers ─────────────────────────────────────────────────────
//
// XLSX shared strings and sheets are well-formed XML, but we deliberately
// avoid DOMParser:
//   - DOMParser loses comments and whitespace handling specifics we don't
//     care about, fine, BUT for large sheets it builds a full DOM tree
//     which can spike memory (a 50k-row sheet is ~10MB of XML).
//   - Regex-based extraction is faster, lighter, and the shape here is
//     small and regular enough to handle correctly with care.
// Both functions tolerate the rich-text variant of <si> (nested <r><t>...
// </t></r>) and Excel's xml:space="preserve" attribute on <t>.

export function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    const parts = [];
    let tm;
    while ((tm = tRe.exec(inner)) !== null) parts.push(decodeXmlEntities(tm[1]));
    out.push(parts.join(""));
  }
  return out;
}

/**
 * Parse a worksheet XML into header + row dicts. Row 1 is treated as the
 * header row. Cells reference shared strings by index when t="s".
 */
export function parseSheet(xml, sst) {
  // First pass: assemble row objects keyed by column letter ("A", "B", ...).
  const rawRows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const inner = rm[1];
    const cells = {};
    const cRe = /<c\s+([^>]*?)\/>|<c\s+([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(inner)) !== null) {
      const attrs = cm[1] ?? cm[2];
      const body  = cm[3] ?? "";
      const ref   = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type  = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "";
      if (!ref) continue;
      const value = decodeCell(type, body, sst);
      if (value !== undefined && value !== null && value !== "") {
        cells[ref] = value;
      }
    }
    rawRows.push(cells);
  }

  if (rawRows.length === 0) return { headers: [], rows: [] };

  // Header row → column letter → header name.
  const headerRow = rawRows[0];
  const colToHeader = {};
  const headers = [];
  for (const col of Object.keys(headerRow).sort(colLetterCompare)) {
    const name = String(headerRow[col]).trim();
    if (!name) continue;
    colToHeader[col] = name;
    headers.push(name);
  }

  // Data rows.
  const rows = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (Object.keys(r).length === 0) continue; // skip fully blank rows
    const obj = {};
    for (const [col, name] of Object.entries(colToHeader)) {
      obj[name] = r[col] ?? "";
    }
    rows.push(obj);
  }
  return { headers, rows };
}

function decodeCell(type, body, sst) {
  // body is everything between <c ...> and </c>. Common shapes:
  //   <v>123</v>                 numeric or shared-string index
  //   <v>1</v>                   boolean (when t="b")
  //   <is><t>literal</t></is>    inline string (when t="inlineStr")
  if (type === "inlineStr") {
    const t = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
    return t ? decodeXmlEntities(t[1]) : "";
  }
  const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (v == null) return "";
  if (type === "s")      return sst[parseInt(v, 10)] ?? "";
  if (type === "b")      return v === "1";
  if (type === "str")    return decodeXmlEntities(v);
  if (type === "e")      return ""; // error cell
  // No explicit type or t="n": numeric. Keep it as a string when it parses
  // unambiguously to a date-like Power BI value handled upstream by
  // parseLockEvents; otherwise return as-is for downstream coercion.
  return decodeXmlEntities(v);
}

function colLetterCompare(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Uint8Array)  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  if (typeof Blob !== "undefined" && input instanceof Blob) return input.arrayBuffer();
  if (input?.arrayBuffer) return input.arrayBuffer();
  throw new Error("xlsx: unsupported input type (expected File, Blob, ArrayBuffer, or Uint8Array)");
}

function utf8Decode(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
