// tools/verify-compute.js
// Runs the rewritten compute against the live captured psn/aisle data and
// checks it reconciles with the known delivery-summary totals.
//   node tools/verify-compute.js

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { rollupByDept, rollupByAisle, shouldIncludeLoad, filterLoadsForDate } from "../lib/compute.js";
import { isFoodCons, decToHHMM } from "../lib/cvRates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(__dirname, "captured", f), "utf8"));

const loads = load("psn-api.json");
const aisleMap = load("aisle-location.json");
const mainJson = load("main-json.json");

// Build planMeta exactly like service.js does.
function buildPlanMeta(m) {
  const source = m.api_for_shipments_source || "sfd";
  const payload = m?.shipments?.data?.trailers?.payload || [];
  const trailers = payload.map((t) => {
    const stop = (t.stops && t.stops[0]) || {};
    const actual = stop.actualShipments || [];
    return {
      loadId: t.transLoadId,
      status: t.loadStatus,
      deliverByTs: stop.inductWindowEndTs || null,
      tz: stop.stopLocationTimeZone || null,
      hasActual: actual.length > 0,
      caseQtyNull: actual.length > 0 && actual[0].caseQuantity == null,
      pckQtyDefined: actual.length > 0 && typeof actual[0].pckQty !== "undefined",
    };
  });
  return {
    source,
    moved: (m.shipments_moved || []).map((mv) => ({ load_id: mv.load_id, unload_date: mv.unload_date })),
    trailers,
  };
}
const planMeta = buildPlanMeta(mainJson);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "✅" : "❌"} ${name}: got ${got}${ok ? "" : ` (want ${want})`}`);
  ok ? pass++ : fail++;
};

// --- Dept rollup ---
const dept = rollupByDept(loads, null);

// Known-good from Shane's delivery summary: Groc/Cons 7,782 + GM 1,400 = 9,182 cases.
const fcCases = dept.filter((t) => t.isFC).reduce((s, t) => s + t.cases, 0);
const gmCases = dept.filter((t) => !t.isFC).reduce((s, t) => s + t.cases, 0);
const totalCases = fcCases + gmCases;
const totalInner = dept.reduce((s, t) => s + t.innerPacks, 0);

console.log("\n=== DEPT ROLLUP ===");
// 92/95 now live only in the aisle section, so dept totals exclude them:
//   Groc/Cons 7,782 - D92 1,436 - D95 1,251 = 5,095;  total 9,182 - 2,687 = 6,495
check("Groc/Cons cases (excl. 92/95)", fcCases, 5095);
check("GM cases", gmCases, 1400);
check("Total cases (excl. 92/95)", totalCases, 6495);
check("Total inner packs (excl. 92/95 = 53)", totalInner, 2689);

// Spot-check specific depts still present.
const byNum = Object.fromEntries(dept.map((t) => [t.deptNbr, t]));
check("D90 cases", byNum[90]?.cases, 711);
check("D91 cases", byNum[91]?.cases, 688);
check("D29 inner", byNum[29]?.innerPacks, 488);

// Hours sanity: D90 = (711 + inner)/48
const d90hours = byNum[90]?.hours;
console.log(`   D90 hours = ${decToHHMM(d90hours)} (${d90hours.toFixed(2)}h)`);

// The aisle section still fully covers 92/95 (verified below).

// --- Aisle rollup (D92/95 only) ---
console.log("\n=== AISLE ROLLUP ===");
const aisle = rollupByAisle(loads, null, aisleMap);
const aisleCasesTotal = aisle.pairs.reduce((s, p) => s + p.totalCases, 0);
const aisleInnerTotal = aisle.pairs.reduce((s, p) => s + p.totalInnerPacks, 0);

// D92+D95 known totals (cases/inner): 1436/53 + 1251/0 = 2687/53.
const d9295cases = 1436 + 1251;
const d9295inner = 53 + 0;
console.log(`   Aisles found: ${aisle.pairs.length}, unknown cases: ${aisle.unknownCases}`);

// Cleaner reconciliation: aisle (cases+inner) + unknown == D92/95 (cases+inner)
const aisleAll = aisleCasesTotal + aisleInnerTotal + aisle.unknownCases;
const deptAll = d9295cases + d9295inner;
check("Aisle total (cases+inner+unknown) = D92/95 total", aisleAll, deptAll);

console.log("   Top 5 aisles by cases:");
[...aisle.pairs].sort((a, b) => b.totalCases - a.totalCases).slice(0, 5)
  .forEach((p) => console.log(`     ${p.label}: ${p.totalCases} cases / ${p.totalInnerPacks} inner = ${decToHHMM(p.hours)}`));

// No multi-aisle labels should survive (e.g. "A20, A17") — they collapse to primary.
const commaLabels = aisle.pairs.filter((p) => p.label.includes(","));
check("No comma/multi-aisle labels leak through", commaLabels.length, 0);
if (commaLabels.length) console.log("   leaked:", commaLabels.map((p) => p.label).join(" | "));

// --- Custom floor layout ordering ---
console.log("\n=== FLOOR LAYOUT ===");
const order = dept.map((t) => t.deptNbr);
console.log("   dept order:", order.join(", "));
const idx = (d) => order.indexOf(d);
// Grouped depts (present in data) must precede ungrouped ones and follow group order.
const groupSeq = [90, 91, 97, 2, 40, 46, 4, 8, 13, 3, 19, 67, 5, 87, 72, 6,
  10, 11, 12, 9, 7, 16, 56, 14, 20, 22, 71, 75,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 93, 94, 98].filter((d) => idx(d) !== -1);
let monotonic = true;
for (let i = 1; i < groupSeq.length; i++) {
  if (idx(groupSeq[i]) < idx(groupSeq[i - 1])) monotonic = false;
}
check("Grouped depts appear in FLOOR_LAYOUT order", monotonic, true);

// 92/95 must NOT appear in the dept rollup (covered by aisles).
check("D92 excluded from dept rollup", dept.some((t) => t.deptNbr === 92), false);
check("D95 excluded from dept rollup", dept.some((t) => t.deptNbr === 95), false);

// Group names must be stamped on tasks.
const d90 = dept.find((t) => t.deptNbr === 90);
check("D90 group = Grocery Coolers & Freezers", d90?.group, "Grocery Coolers & Freezers");
const d94 = dept.find((t) => t.deptNbr === 94);
check("D94 group = Fresh", d94?.group, "Fresh");
const d6 = dept.find((t) => t.deptNbr === 6);
if (d6) check("D6 group = Electronics", d6.group, "Electronics");

// --- Date filter (psn_checkIncludeInPlanOrNot port) ---
console.log("\n=== DATE FILTER (today vs tomorrow) ===");
const planLoadIds = new Set(loads.map((l) => l.load_id));
console.log(`   psn loads: ${loads.length}; trailer meta: ${planMeta.trailers.length}; moved: ${planMeta.moved.length}`);

// For THIS capture every trailer's deliver-by is store-local 2026-07-28,
// so filtering to that date keeps all psn loads.
const keptToday = filterLoadsForDate(loads, "2026-07-28", planMeta);
check("All loads kept for their real plan date (2026-07-28)", keptToday.length, loads.length);

// Running the SAME data for the NEXT day should drop the loads whose deliver-by
// is 2026-07-28 (i.e. everything with trailer meta).
const keptTomorrow = filterLoadsForDate(loads, "2026-07-29", planMeta);
const haveMeta = loads.filter((l) => planMeta.trailers.some((t) => String(t.loadId) === String(l.load_id)));
check("Next-day plan excludes today's delivered loads",
  keptTomorrow.length, loads.length - haveMeta.length);

// Synthetic: a trailer manually moved to unload tomorrow must be excluded today.
const sampleId = [...planLoadIds][0];
const movedMeta = { ...planMeta, moved: [{ load_id: sampleId, unload_date: "2026-07-29" }] };
check("Moved-to-tomorrow trailer excluded from today",
  shouldIncludeLoad(sampleId, "2026-07-28", movedMeta), false);
check("Moved-to-tomorrow trailer included tomorrow",
  shouldIncludeLoad(sampleId, "2026-07-29", movedMeta), true);

// Synthetic: a canceled trailer is always excluded.
const cancelMeta = { ...planMeta,
  trailers: [{ loadId: sampleId, status: "Tender Canceled" }] };
check("Canceled trailer excluded", shouldIncludeLoad(sampleId, "2026-07-28", cancelMeta), false);

console.log(`\n${fail === 0 ? "🎉 ALL PASS" : "💥 FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
