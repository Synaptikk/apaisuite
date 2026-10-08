// modules/punchlookup/lib/xlsx_write.js
//
// Minimal .xlsx WRITER (shared/xlsx.js only reads). Enough for a neat,
// editable workbook: several sheets, inline strings, numbers, time values,
// formulas, a handful of fixed styles, column widths, merged title cells and
// a frozen header row. The ZIP is "stored" (no compression) — a review
// workbook is a few KB. Pure; returns a Uint8Array.
//
// Cell spec: null | string | number | { v, s, f, t }
//   v value, s style name (STYLE below), f formula (no "="), t "time" for a
//   fraction-of-a-day value shown as h:mm AM/PM.

const STYLE = {
  default: 0, title: 1, label: 2, head: 3, time: 4, int: 5, wrap: 6,
  work: 7, nonwork: 8, unclear: 9, warn: 10, total: 11, totalInt: 12, sub: 13,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="h:mm AM/PM"/></numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="9"/><color rgb="FF666666"/><name val="Calibri"/></font>
</fonts>
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="1" fontId="2" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
</styleSheet>`;

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  // XML 1.0 forbids most control characters; a pasted note can carry them.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

export function colName(i) {
  let s = ""; i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function cellXml(ref, c) {
  if (c == null || c === "") return "";
  const spec = typeof c === "object" ? c : { v: c };
  const s = STYLE[spec.s ?? (spec.t === "time" ? "time" : "default")] ?? 0;
  const sa = s ? ` s="${s}"` : "";
  if (spec.f) {
    const v = typeof spec.v === "number" ? `<v>${spec.v}</v>` : "";
    return `<c r="${ref}"${sa}><f>${xmlEsc(spec.f)}</f>${v}</c>`;
  }
  if (typeof spec.v === "number" && Number.isFinite(spec.v)) return `<c r="${ref}"${sa}><v>${spec.v}</v></c>`;
  if (spec.v == null || spec.v === "") return sa ? `<c r="${ref}"${sa}/>` : "";
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(spec.v)}</t></is></c>`;
}

/**
 * sheet: { name, rows: [[cell]], widths: [chars], hidden: [colIndex], merges: ["A1:F1"],
 *          freezeRow, heights: { rowIndex: pt }, lists: [{ ref: "D8:D300", items: ["Work", …] | range: "Days!$A$7:$A$40", prompt }] }
 */
function sheetXml(sheet) {
  const rows = sheet.rows.map((r, ri) => {
    const cells = (r || []).map((c, ci) => cellXml(`${colName(ci)}${ri + 1}`, c)).join("");
    const ht = sheet.heights?.[ri] ? ` ht="${sheet.heights[ri]}" customHeight="1"` : "";
    return cells || ht ? `<row r="${ri + 1}"${ht}>${cells}</row>` : "";
  }).join("");
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${sheet.hidden?.includes(i) ? ' hidden="1"' : ""}/>`).join("")}</cols>` : "";
  const freeze = sheet.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  // In-cell dropdowns (Data Validation lists): `items` inline (no commas in
  // an item, 255 characters in all) or `range` ("Days!$A$7:$A$40").
  const lists = sheet.lists?.length ? `<dataValidations count="${sheet.lists.length}">${sheet.lists.map((l) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1"${l.prompt ? ` showInputMessage="1" prompt="${xmlEsc(l.prompt)}"` : ""} sqref="${l.ref}"><formula1>${l.range ? xmlEsc(l.range) : `"${xmlEsc(l.items.join(","))}"`}</formula1></dataValidation>`).join("")}</dataValidations>` : "";
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rows}</sheetData>${merges}${lists}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

// Overlapping merged ranges make Excel refuse the whole file ("Unable to get
// the Open property"), so they are caught here rather than by the user.
function checkMerges(sheet) {
  const box = (ref) => {
    const [a, b] = ref.split(":").map((c) => /^([A-Z]+)(\d+)$/.exec(c));
    const col = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    return { c0: col(a[1]), r0: Number(a[2]), c1: col(b[1]), r1: Number(b[2]) };
  };
  const bs = (sheet.merges || []).map(box);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const x = bs[i], y = bs[j];
    if (x.c0 <= y.c1 && y.c0 <= x.c1 && x.r0 <= y.r1 && y.r0 <= x.r1) {
      throw new Error(`xlsx: merged ranges ${sheet.merges[i]} and ${sheet.merges[j]} overlap on sheet "${sheet.name}"`);
    }
  }
}

/** Excel sheet names: ≤31 chars, none of []:*?/\ , unique. */
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map((s) => {
    let base = String(s.name || "Sheet").replace(/[[\]:*?/\\]/g, "-").slice(0, 31) || "Sheet", n = base, k = 2;
    while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${k++}`;
    used.add(n.toLowerCase());
    return n;
  });
}

// ── stored ZIP ───────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function zipStored(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of files) {
    const nameB = enc.encode(name), body = typeof data === "string" ? enc.encode(data) : data;
    const crc = crc32(body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, body.length, true);
    local.setUint16(26, nameB.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameB, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, body.length, true); cd.setUint32(24, body.length, true);
    cd.setUint16(28, nameB.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameB);
    offset += 30 + nameB.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

/** sheets → .xlsx bytes. */
export function buildXlsx(sheets) {
  sheets.forEach(checkMerges);
  const names = sheetNames(sheets);
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zipStored(files);
}
