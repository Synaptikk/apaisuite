import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fillWorkbook, patchSheet, excelDateSerial } from "../xlsx.js";

const TEMPLATE = new URL("../../templates/worksheet.xlsx", import.meta.url);

test("patchSheet writes numbers, text and strips cached formula values", () => {
  const xml =
    '<row r="7"><c r="A7" s="1"/><c r="C7" s="12"/><c r="E7" s="3"><f>SUM(C7:D7)</f><v>0</v></c></row>' +
    '<row r="3"><c r="B3" s="2"/></row>';
  const out = patchSheet(xml, { C7: 1234.56, C3: "1458" });

  assert.match(out, /<c r="C7" s="12"><v>1234.56<\/v><\/c>/);
  assert.match(out, /<c r="C3" t="inlineStr"><is><t xml:space="preserve">1458<\/t><\/is><\/c>/);
  assert.match(out, /<c r="E7" s="3"><f>SUM\(C7:D7\)<\/f><\/c>/);   // cached <v> gone, formula kept
});

test("fills the real template and produces a readable workbook", async () => {
  const bytes = fs.readFileSync(TEMPLATE);
  const filled = await fillWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    C3: "1458", E3: excelDateSerial("2026-09-22"),
    C7: 70000, C8: 15354.64, C13: 478479.34, C14: 71320.61, C15: 388001.77,
    D7: 15000, D8: 1183.11,
    G7: 38000, G8: 9314.82,
    J7: 27000, J8: 1164.65,
  });

  assert.ok(filled.length > 10000, "workbook should not be empty");
  assert.equal(filled[0], 0x50);                      // "PK"
  assert.equal(filled[1], 0x4b);

  // Re-read it the same way the exporter reads the template.
  const sheet = await readEntry(filled, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /<c r="C7"[^>]*><v>70000<\/v><\/c>/);
  assert.match(sheet, /<c r="J8"[^>]*><v>1164.65<\/v><\/c>/);
  assert.match(sheet, /<c r="C3"[^>]*t="inlineStr"><is><t[^>]*>1458</);
  assert.match(sheet, /<c r="E3"[^>]*><v>46287<\/v><\/c>/);   // date as a serial, not text
  assert.match(sheet, /C7\+C8\+C9/);                   // the sheet's own formula survived

  const workbook = await readEntry(filled, "xl/workbook.xml");
  assert.match(workbook, /fullCalcOnLoad="1"/);

  // Every part of the original is still present.
  const names = await listEntries(filled);
  for (const required of ["[Content_Types].xml", "xl/styles.xml", "xl/sharedStrings.xml", "xl/theme/theme1.xml"]) {
    assert.ok(names.includes(required), "missing " + required);
  }
  // Written somewhere disposable: handy to open in Excel when this fails,
  // but not a build artifact that lands in the repo.
  fs.writeFileSync(path.join(os.tmpdir(), "costinventory-export-check.xlsx"), filled);
});

// Minimal reader for the STORED zip the exporter writes.
async function listEntries(bytes) {
  const { entries } = parse(bytes);
  return entries.map((e) => e.name);
}
async function readEntry(bytes, name) {
  const { entries } = parse(bytes);
  const hit = entries.find((e) => e.name === name);
  assert.ok(hit, "entry not found: " + name);
  return new TextDecoder().decode(hit.data);
}
function parse(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    entries.push({ name, data: bytes.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

test("dates become Excel serials", () => {
  // The template's own "Updated" stamp is the serial 44622, and this has to
  // agree with it.
  assert.equal(excelDateSerial("2022-03-02"), 44622);
  assert.equal(excelDateSerial("2026-09-22"), 46287);
});
