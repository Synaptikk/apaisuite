// Standalone test harness for market120 WoW logic — runs in plain Node.
// Verifies parse_stores_csv against the REAL captured CD_Store.csv and the
// history/WoW computation across two synthetic weeks. No chrome needed:
// we stub chrome.storage.local with an in-memory map.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MODULE = "C:/Users/ses008s.s01458/Desktop/APAISuite/unified-extension-suite/modules/market120";
const CAPTURE = "C:/Users/ses008s.s01458/Desktop/Trey/captures/CD_Store.csv";

// ── Stub chrome.storage.local (must exist BEFORE importing history.js) ──
const mem = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { const k = typeof key === "string" ? key : key; return k in mem ? { [k]: mem[k] } : {}; },
      async set(obj) { Object.assign(mem, obj); },
      async remove(key) { delete mem[key]; },
    },
  },
};

const { parseStoresCsv } = await import(`file://${MODULE}/lib/parse_stores_csv.js`);
const { parseNationalTotal } = await import(`file://${MODULE}/lib/parse_stores_csv.js`);
const { computeBreakdown } = await import(`file://${MODULE}/lib/breakdown.js`);
const { hbarSvg, donutSvg } = await import(`file://${MODULE}/lib/charts.js`);
const history = await import(`file://${MODULE}/lib/history.js`);

let pass = 0, fail = 0;
const ok  = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ FAIL:", m); } };

// Read the real capture (UTF-16LE) and decode as the content-script would deliver it.
function readUtf16(p) {
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  return buf.toString("utf8");
}

console.log("\n[1] parseStoresCsv against real CD_Store.csv (Market 120)");
const csv = readUtf16(CAPTURE);
const parsed = parseStoresCsv(csv, { market: "120" });
ok(parsed.ok, "parse ok");
ok(parsed.rows.length > 0, `got ${parsed.rows.length} Market 120 store rows`);
ok(parsed.rows.every(r => r.market === "120"), "all rows are Market 120");
ok(parsed.rows.every(r => typeof r.totalDollars === "number"), "totalDollars numeric");
const sample = parsed.rows[0];
console.log("    sample row:", JSON.stringify(sample));

console.log("\n[2] Guard: wrong sheet rejected");
const wrong = parseStoresCsv("Category\tClearance Quantity\nFOO\t10", { market: "120" });
ok(!wrong.ok, "rejects a non-Store sheet");

console.log("\n[3] History: week 1 baseline (no deltas)");
const wk1 = new Date("2026-07-29T09:00:00Z");
await history.recordSnapshot(parsed.rows, wk1);
let wow = await history.computeWoW();
ok(wow.rows.length === parsed.rows.length, `WoW rows = ${wow.rows.length}`);
ok(wow.priorWeek === null, "no prior week yet");
ok(wow.rows.every(r => r.dDollars === null), "deltas null on baseline week");
console.log("    currentWeek:", wow.currentWeek, "weekCount:", wow.weekCount);

console.log("\n[4] History: week 2 produces deltas");
// Simulate next week: bump every store's dollars by +1000, units by +50.
const wk2rows = parsed.rows.map(r => ({ ...r, totalDollars: r.totalDollars + 1000, totalUnits: r.totalUnits + 50 }));
const wk2 = new Date("2026-08-05T09:00:00Z");
await history.recordSnapshot(wk2rows, wk2);
wow = await history.computeWoW();
ok(wow.priorWeek !== null, `prior week set (${wow.priorWeek})`);
ok(wow.currentWeek !== wow.priorWeek, "current != prior");
const r0 = wow.rows[0];
ok(r0.dDollars === 1000, `dDollars = ${r0.dDollars} (expected 1000)`);
ok(r0.dUnits === 50, `dUnits = ${r0.dUnits} (expected 50)`);
ok(Math.abs(r0.pctDollars - (1000 / Math.abs(r0.prevDollars) * 100)) < 1e-6, "pctDollars correct");
console.log("    top row WoW:", JSON.stringify(r0));

console.log("\n[5] History: same-week refresh is idempotent (no phantom week)");
await history.recordSnapshot(wk2rows, wk2); // re-run same ISO week
const wc = await history.weekCount();
ok(wc === 2, `weekCount stayed at 2 (got ${wc})`);

console.log("\n[6] History: new store appears next week => isNew");
const wk3rows = [...wk2rows, { store: "9999", market: "120", totalDollars: 500, totalUnits: 5, clearanceDollars:0, clearanceQty:0, deletedDollars:0, deletedQty:0, bu:"A", region:"12" }];
await history.recordSnapshot(wk3rows, new Date("2026-08-12T09:00:00Z"));
wow = await history.computeWoW();
const newStore = wow.rows.find(r => r.store === "9999");
ok(newStore && newStore.isNew === true, "brand-new store flagged isNew");

console.log("\n[7] parseNationalTotal extracts the grand Total row");
const natRes = parseNationalTotal(csv);
ok(natRes.ok, "national Total row found");
ok(natRes.national.totalDollars > 100_000_000, `national C/D $ = ${natRes.national.totalDollars.toLocaleString()} (>$100M)`);
ok(natRes.national.totalUnits > 1_000_000, `national units = ${natRes.national.totalUnits.toLocaleString()}`);
console.log("    national:", JSON.stringify(natRes.national));

console.log("\n[8] computeBreakdown produces market rollup + context");
const bd = computeBreakdown(parsed.rows, natRes.national, { market: "120", topN: 10 });
ok(bd.market120.storeCount === parsed.rows.length, `storeCount = ${bd.market120.storeCount}`);
const sumDollars = parsed.rows.reduce((s, r) => s + r.totalDollars, 0);
ok(Math.abs(bd.market120.dollars - sumDollars) < 1, "market $ equals sum of store rows");
ok(bd.pctDollars > 0 && bd.pctDollars < 100, `pctDollars in range: ${bd.pctDollars.toFixed(2)}%`);
ok(Math.abs(bd.clrShareDol + bd.delShareDol - 100) < 0.01, "clearance% + deleted% = 100%");
ok(bd.topStores.length === Math.min(10, parsed.rows.length), `topStores length = ${bd.topStores.length}`);
ok(bd.topStores[0].dollars >= bd.topStores[bd.topStores.length - 1].dollars, "topStores sorted desc by $");
ok(bd.insights.length >= 3, `insights generated: ${bd.insights.length}`);
console.log("    market120:", JSON.stringify(bd.market120));
console.log("    insight[0]:", bd.insights[0].replace(/<\/?b>/g, ""));

console.log("\n[9] computeBreakdown degrades gracefully with no national row");
const bd2 = computeBreakdown(parsed.rows, null, { market: "120" });
ok(bd2.pctDollars === null, "pctDollars null when national missing");
ok(bd2.national === null, "national null");
ok(bd2.insights.length >= 3, "still builds insights without national");

console.log("\n[10] charts render valid SVG strings");
const bar = hbarSvg(bd.topStores.map((s) => ({ label: "#" + s.store, value: s.dollars })), { fmt: (v) => "$" + v });
ok(bar.startsWith("<svg") && bar.includes("</svg>"), "hbarSvg returns an <svg>");
ok((bar.match(/<rect/g) || []).length === bd.topStores.length, "one bar rect per store");
const donut = donutSvg([{ label: "Clearance $", value: bd.market120.clrDol, color: "#ffc220" }, { label: "Deleted $", value: bd.market120.delDol, color: "#0053e2" }], { centerLabel: "total" });
ok(donut.includes("<svg") && donut.includes("mkt120-legend"), "donutSvg returns svg + legend");
ok((donut.match(/<circle/g) || []).length === 2, "two donut slices");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);