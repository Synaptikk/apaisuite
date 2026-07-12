// dev/probe-livedashboard-phase2-final.mjs
//
// Final phase-2 integration test:
//   1. Reload extension; navigate to #/home
//   2. Verify NO duplicate dashboard mounts (the renderHome race fix)
//   3. Trigger pull_compliance (verify 4th widget populated)
//   4. Generate a synthetic register XLSX and POST it via import_register
//   5. Verify register widget shows finding counts
//   6. Screenshot each step

import puppeteer from "puppeteer-core";
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BROWSER_URL = "http://localhost:9222";
const EXT_NAME    = "APAISuite";

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });

const extPage = await browser.newPage();
await extPage.goto("edge://extensions/", { waitUntil: "domcontentloaded", timeout: 10000 });
const all = await extPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (info) => resolve(info));
  });
});
const info = all.find((x) => x.name === EXT_NAME);
const extensionId = info.id;
console.log(`✓ ${EXT_NAME} v${info.version} (${extensionId})`);

await extPage.evaluate(async (id) => {
  await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
}, extensionId);
await extPage.close().catch(() => {});
await new Promise((r) => setTimeout(r, 1800));

const appPage = await browser.newPage();
await appPage.setViewport({ width: 1600, height: 1000 });
appPage.on("pageerror", (err) => console.error("  PAGE ERROR:", err.message));

await appPage.goto(`chrome-extension://${extensionId}/app.html#/home`, { waitUntil: "domcontentloaded", timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));

// === Check 1: no duplicate dashboard mounts ===
const dashCount = await appPage.evaluate(() => document.querySelectorAll(".module-livedashboard .ld-root").length);
console.log(`\n=== Check 1: dashboard mount count ===`);
console.log(`  dashboards on page: ${dashCount} ${dashCount === 1 ? "✓" : "✗ DUPLICATE BUG"}`);

// === Check 2: trigger compliance pull ===
console.log(`\n=== Check 2: pull_compliance ===`);
const compRes = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "pull_compliance" }, resolve);
  });
});
const cr = compRes?.data ?? compRes;
console.log(`  ok: ${cr?.ok}  total: ${cr?.counts?.total}  overdue: ${cr?.counts?.overdue}  dueSoon: ${cr?.counts?.dueSoon}`);

await new Promise((r) => setTimeout(r, 1000));
await appPage.screenshot({ path: "phase2-final-1-after-compliance.png", fullPage: false });
console.log(`  📸 phase2-final-1-after-compliance.png`);

// === Check 3: generate + import a synthetic register XLSX ===
console.log(`\n=== Check 3: register XLSX import ===`);
// Build a minimal XLSX using zip + xml strings (no external dep). We use
// the standard OOXML SpreadsheetML format that digitallocks' reader
// already understands.
const xlsxBuffer = buildSyntheticRegisterXlsx();
const b64 = xlsxBuffer.toString("base64");
console.log(`  synthetic xlsx: ${xlsxBuffer.length} bytes, ${b64.length} chars b64`);

const importRes = await appPage.evaluate(async (b64) => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      module: "livedashboard", type: "import_register",
      fileBase64: b64, filename: "synthetic-test.xlsx",
    }, resolve);
  });
}, b64);
const ir = importRes?.data ?? importRes;
console.log(`  ok: ${ir?.ok}`);
if (ir?.ok) {
  console.log(`  discrepancies parsed: ${ir.discrepancies}`);
  console.log(`  findings: ${ir.findings}`);
  console.log(`  counts: ${JSON.stringify(ir.counts)}`);
} else {
  console.log(`  error: ${ir?.error}`);
}

await new Promise((r) => setTimeout(r, 1000));

// Click the register widget to open its drill
await appPage.evaluate(() => document.querySelector("#ld-w-register")?.click());
await new Promise((r) => setTimeout(r, 800));
await appPage.screenshot({ path: "phase2-final-2-register-drill.png", fullPage: false });
console.log(`  📸 phase2-final-2-register-drill.png`);

// === Check 4: store switch behavior ===
console.log(`\n=== Check 4: store switch (1458 → 670 → 1458) ===`);
// Read current store
const before = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "get_dashboard_state" }, resolve);
  });
});
console.log(`  initial store: ${before?.data?.storeNbr ?? before?.storeNbr}`);

const sw1 = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "set_store", storeNbr: "670" }, resolve);
  });
});
const s1 = sw1?.data ?? sw1;
console.log(`  → 670: ok=${s1?.ok} cvp.ok=${s1?.cvp?.ok} store=${s1?.settings?.storeNbr}`);

const sw2 = await appPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "livedashboard", type: "set_store", storeNbr: "1458" }, resolve);
  });
});
const s2 = sw2?.data ?? sw2;
console.log(`  → 1458: ok=${s2?.ok} cvp.ok=${s2?.cvp?.ok} store=${s2?.settings?.storeNbr} sellThru=${s2?.cvp?.byCategory?.headline?.currentWeek?.sellThruPctTy?.toFixed?.(1)}%`);

await new Promise((r) => setTimeout(r, 500));
await appPage.screenshot({ path: "phase2-final-3-final.png", fullPage: false });
console.log(`  📸 phase2-final-3-final.png`);

browser.disconnect();
process.exit(0);

// ── Synthetic XLSX builder ──────────────────────────────────────────
// Minimal OOXML SpreadsheetML covering what digitallocks' reader supports:
//   - xl/sharedStrings.xml (for the register header label + dates)
//   - xl/worksheets/sheet1.xml (rows with numeric + sharedString cells)
//   - Content types + workbook + relationships
function buildSyntheticRegisterXlsx() {
  // Test data: 3 registers × 5 dates, with crafted patterns:
  //   Reg 67 short $20 on 2026-05-30 (R2-matchable to reg 68 over $23 on 2026-05-31)
  //   Reg 10 short $200 on 2026-05-29 (R2-matchable to reg 11 over $200 same day)
  //   Reg 42 short $155 on 2026-05-28 (R1 unmatched, no offset)
  //   Reg 42 short $310 on 2026-05-29 (R1 unmatched, high severity)
  const sharedStrings = ["Register", "2026-05-28", "2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01"];
  const rows = [
    // Header
    { _isHeader: true, cells: sharedStrings.map((s) => ({ kind: "s", v: s })) },
    // Reg 10: short $200 on 2026-05-29
    { _isHeader: false, cells: [
      { kind: "n", v: 10 }, { kind: "n", v: 0 }, { kind: "n", v: -200 }, { kind: "n", v: 0 }, { kind: "n", v: 0 }, { kind: "n", v: 0 },
    ]},
    // Reg 11: over $200 on 2026-05-29
    { _isHeader: false, cells: [
      { kind: "n", v: 11 }, { kind: "n", v: 0 }, { kind: "n", v: 200 }, { kind: "n", v: 0 }, { kind: "n", v: 0 }, { kind: "n", v: 0 },
    ]},
    // Reg 42: short $155 on 2026-05-28, short $310 on 2026-05-29
    { _isHeader: false, cells: [
      { kind: "n", v: 42 }, { kind: "n", v: -155 }, { kind: "n", v: -310 }, { kind: "n", v: 0 }, { kind: "n", v: 0 }, { kind: "n", v: 0 },
    ]},
    // Reg 67: short $20 on 2026-05-30
    { _isHeader: false, cells: [
      { kind: "n", v: 67 }, { kind: "n", v: 0 }, { kind: "n", v: 0 }, { kind: "n", v: -20 }, { kind: "n", v: 0 }, { kind: "n", v: 0 },
    ]},
    // Reg 68: over $23 on 2026-05-31
    { _isHeader: false, cells: [
      { kind: "n", v: 68 }, { kind: "n", v: 0 }, { kind: "n", v: 0 }, { kind: "n", v: 0 }, { kind: "n", v: 23 }, { kind: "n", v: 0 },
    ]},
  ];

  // Build XML strings
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join("")}
</sst>`;

  const colLetter = (i) => String.fromCharCode(65 + i);
  const sheetRowsXml = rows.map((row, rIdx) => {
    const r = rIdx + 1;
    const cellsXml = row.cells.map((c, ci) => {
      const ref = `${colLetter(ci)}${r}`;
      if (c.kind === "s") return `<c r="${ref}" t="s"><v>${c.v == null ? 0 : sharedStrings.indexOf(c.v)}</v></c>`;
      return `<c r="${ref}"><v>${c.v}</v></c>`;
    }).join("");
    return `<row r="${r}">${cellsXml}</row>`;
  }).join("");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRowsXml}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"            ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml"   ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml"       ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  // Pack into ZIP — write to a temp directory and use 7z/zip if available;
  // otherwise hand-roll a stored-only ZIP (uncompressed) which is what
  // digitallocks/lib/xlsx.js supports.
  const parts = [
    { name: "[Content_Types].xml",          data: Buffer.from(contentTypesXml) },
    { name: "_rels/.rels",                   data: Buffer.from(rootRelsXml) },
    { name: "xl/workbook.xml",               data: Buffer.from(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels",    data: Buffer.from(workbookRelsXml) },
    { name: "xl/sharedStrings.xml",          data: Buffer.from(sstXml) },
    { name: "xl/worksheets/sheet1.xml",      data: Buffer.from(sheetXml) },
  ];

  return buildStoredZip(parts);
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;" }[c]));
}

// Build a stored-only (uncompressed) ZIP — the simplest format that
// digitallocks/lib/xlsx.js can read.
function buildStoredZip(parts) {
  const crc32 = makeCrc32();
  const localHeaders = [];
  const fileData     = [];
  let offset = 0;
  for (const p of parts) {
    const nameBytes = Buffer.from(p.name, "utf-8");
    const data      = p.data;
    const crc       = crc32(data);
    const lfh       = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header sig
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0, 6);          // gp bit flag
    lfh.writeUInt16LE(0, 8);          // compression = stored
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0, 12);         // mod date
    lfh.writeUInt32LE(crc, 14);       // crc-32
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra len
    const entry = Buffer.concat([lfh, nameBytes, data]);
    localHeaders.push({ name: nameBytes, crc, size: data.length, offset });
    fileData.push(entry);
    offset += entry.length;
  }
  // Central directory
  const cds = [];
  for (const h of localHeaders) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir header sig
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0, 8);          // gp flag
    cd.writeUInt16LE(0, 10);         // compression
    cd.writeUInt16LE(0, 12);         // mod time
    cd.writeUInt16LE(0, 14);         // mod date
    cd.writeUInt32LE(h.crc, 16);
    cd.writeUInt32LE(h.size, 20);
    cd.writeUInt32LE(h.size, 24);
    cd.writeUInt16LE(h.name.length, 28);
    cd.writeUInt16LE(0, 30);         // extra len
    cd.writeUInt16LE(0, 32);         // comment len
    cd.writeUInt16LE(0, 34);         // disk #
    cd.writeUInt16LE(0, 36);         // internal attrs
    cd.writeUInt32LE(0, 38);         // external attrs
    cd.writeUInt32LE(h.offset, 42);  // local header offset
    cds.push(Buffer.concat([cd, h.name]));
  }
  const cdSize   = cds.reduce((n, b) => n + b.length, 0);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...fileData, ...cds, eocd]);
}

function makeCrc32() {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = (tbl[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
}
