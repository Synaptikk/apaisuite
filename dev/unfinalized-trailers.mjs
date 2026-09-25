// End-to-end proof of the "Unfinalized Trailer totals" panel:
// CaseVisibility (which trailers, and are they MP or FDD) x GDP (the money).
import puppeteer from "puppeteer-core";
const STORE = process.argv[2] || "1458";
const NIGHT = process.argv[3] || "2026-09-21";     // CV business date = the night before the count
const FRESH_TYPES = ["MP", "MPDD", "FDD"];

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// ── 1. CaseVisibility: trailers for that night, with their shipment type ──
const cv = await browser.newPage();
await cv.goto("https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 6000));
const loads = await cv.evaluate(async (storeNbr, businessDate) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector("#inpStoreNbr").value = storeNbr;
  const di = document.querySelector("#inpDate"); if (di) di.value = businessDate;
  const dl = Date.now() + 15000;
  while (typeof window.main_search !== "function" && Date.now() < dl) await sleep(200);
  window.main_search();
  await sleep(500);
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) { await sleep(400);
    const el = document.querySelector("#divImgProcessing");
    if (!el || getComputedStyle(el).display === "none") break; }
  await sleep(1500);
  return ((typeof main_json !== "undefined" && main_json?.sdl) || [])
    .map(d => ({ type: d.shipment_type, trailer: String(d.trailer_id), actual: d.actual_delivery_ts, sched: d.sched_delivery_ts }));
}, STORE, NIGHT);
await cv.close();

const fresh = loads.filter(l => FRESH_TYPES.includes(l.type));
console.log(`CaseVisibility ${STORE} night of ${NIGHT}: ${loads.length} loads, ${fresh.length} fresh`);
for (const l of fresh) console.log(`   ${l.type.padEnd(4)} trailer ${l.trailer}  arrived ${l.actual || "(not yet)"}`);
if (!fresh.length) { await browser.disconnect(); process.exit(0); }

// ── 2. GDP: cost by dept for exactly those trailers ───────────────────────
const gdp = await browser.newPage();
let bearer = null;
gdp.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await gdp.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));

const since = new Date(NIGHT + "T00:00:00Z"); since.setUTCDate(since.getUTCDate() - 10);
const until = new Date(NIGHT + "T00:00:00Z"); until.setUTCDate(until.getUTCDate() + 3);
const rows = await gdp.evaluate(async (bearer, store, trailers, start, end) => {
  const legacy = { Store_Nbr: store, Dept_Nbr: "", Invoice_Nbr: "",
                   Trailer_Nbr: trailers.map(t => `'${t}'`).join(","),   // STRING column -> must be quoted
                   start_date: start, end_date: end, limit: "5000", offset: "0" };
  const body = { datasetId: 1727, visualizationId: 2268, dashboardId: 351,
    queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
      datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
      dashboardRunTimeParams: legacy, visualizationFilterDetails: "", nextGenSqlParams: {} },
      projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } };
  const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "u" + Date.now() }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) return { error: (j.error.message || "").slice(0, 200) };
  const cols = (j.columns || []).map(c => c.name);
  return (j.values || []).map(v => Object.fromEntries(cols.map((k, i) => [k, v[i]])));
}, bearer, STORE, fresh.map(f => f.trailer), since.toISOString().slice(0,10), until.toISOString().slice(0,10));
await gdp.close(); await browser.disconnect();

if (rows.error) { console.log("GDP error:", rows.error); process.exit(1); }

const typeOf = new Map(fresh.map(f => [f.trailer, f.type]));
const DEPTS = [93, 80, 94, 98];
const NAME = { 93: "Meat/Seafood", 80: "Deli", 94: "Produce", 98: "Bakery" };
const byTrailer = new Map();
for (const r of rows) {
  const t = String(r.Trailer_Number);
  const cur = byTrailer.get(t) || { trailer: t, type: typeOf.get(t) || "?", dates: new Set(), depts: {} };
  cur.dates.add(r.INVOICE_DATE);
  cur.depts[r.DEPT_NUMBER] = (cur.depts[r.DEPT_NUMBER] || 0) + (r.Total_Cost || 0);
  byTrailer.set(t, cur);
}
const money = (n) => "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
console.log(`\nUnfinalized Trailer totals:`);
const totals = {};
for (const v of [...byTrailer.values()].sort((a, b) => a.type.localeCompare(b.type))) {
  console.log(`\n  ${v.type} — trailer ${v.trailer}   (invoiced ${[...v.dates].join(", ")})`);
  let sub = 0;
  for (const d of DEPTS) { const amt = v.depts[d] || 0; sub += amt;
    console.log(`     ${d} ${NAME[d].padEnd(13)} ${money(amt).padStart(12)}`); }
  console.log(`     ${"trailer total".padEnd(17)} ${money(sub).padStart(12)}`);
  totals[v.type] = (totals[v.type] || 0) + sub;
}
console.log("");
let grand = 0;
for (const [t, amt] of Object.entries(totals)) { console.log(`  All ${t} trailers: ${money(amt)}`); grand += amt; }
console.log(`  MP + FDD combined: ${money(grand)}`);
console.log(`\n  Per-department across all trailers (row 8 of the worksheet):`);
for (const d of DEPTS) {
  const amt = [...byTrailer.values()].reduce((s, v) => s + (v.depts[d] || 0), 0);
  console.log(`     ${d} ${NAME[d].padEnd(13)} ${money(amt).padStart(12)}`);
}
