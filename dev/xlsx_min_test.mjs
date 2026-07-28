// Quick self-test for xlsx_min.js — builds a tiny real .xlsx with Node's
// zlib (deflateRaw + a hand-rolled ZIP writer) and round-trips it.
import zlib from "node:zlib";
import { parseXlsx } from "../modules/metricshot/lib/sources/xlsx_min.js";

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);          // method deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const local = Buffer.concat([lh, Buffer.from(nameB), Buffer.from(comp)]);
    locals.push(local);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, Buffer.from(nameB)]));
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cd, eocd]);
}

const shared = `<?xml version="1.0"?><sst><si><t>Location</t></si><si><t>Location Age</t></si><si><t>003/006</t></si><si><t>Status</t></si><si><t>Overdue</t></si></sst>`;
const sheet = `<?xml version="1.0"?><worksheet><sheetData>` +
  `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>` +
  `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>13.5</v></c><c r="C2" t="s"><v>4</v></c></row>` +
  `</sheetData></worksheet>`;

const bytes = new Uint8Array(zip([
  ["xl/sharedStrings.xml", shared],
  ["xl/worksheets/sheet1.xml", sheet],
]));

const res = await parseXlsx(bytes);
console.log(JSON.stringify(res, null, 2));
const ok = res.ok
  && res.rows[0].join("|") === "Location|Location Age|Status"
  && res.rows[1].join("|") === "003/006|13.5|Overdue";
console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
