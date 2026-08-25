// dev/probe-tableau-pull.mjs
//
// End-to-end proof for the digitalmetrics automated pull:
//   read filter domains → apply Pick Date + Store # → getSummaryDataAsync
//
// dev/probe-tableau-jsapi.mjs got 0 rows / 0 columns because the view opens
// with "Select Pick Date First" and "Select Store Number(s) Second" both at
// (None) — no marks, so nothing to summarise. The worksheet labels are telling
// you the API contract: this dashboard yields data only once it is scoped.
//
//   node dev/probe-tableau-pull.mjs                       # home store, latest WM week
//   node dev/probe-tableau-pull.mjs --store=1458 --week=202630
//   node dev/probe-tableau-pull.mjs --store=1458 --dates=7   # last N Pick Dates
//
// Read-only in the sense that matters: applyFilterAsync changes only this
// browser session's view state, never the saved workbook. It runs in the
// dedicated debug profile, so your normal Tableau session is untouched.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";

const arg = (name, dflt = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : dflt;
};
const STORE     = arg("store", "1458");
const WEEK      = arg("week");
const DATE_COUNT = Number(arg("dates", "3"));
const WORKSHEET = arg("worksheet", "Associate By Day");

const URL_ = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance?:iid=1&:linktarget=_self";
const OUT = resolve(HERE, "tableau-pull-probe.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { url: URL_, store: STORE, week: WEEK, worksheet: WORKSHEET, startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}\n  Run ./dev/launch-edge-debug.sh`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60_000 });

console.log("→ waiting for VizManager ...");
const ready = await page.waitForFunction(
  () => { try { return (window.tableau?.VizManager?.getVizs?.() || []).length > 0; } catch { return false; } },
  { timeout: 120_000, polling: 500 },
).then(() => true).catch(() => false);
if (!ready) { out.error = "viz never registered"; save(); console.error("✗ viz never registered"); process.exit(1); }
console.log("✓ viz registered");
await sleep(3000);

// ── what can we actually read off each filter? ────────────────────────────
//
// getDomainAsync() does NOT exist on the JS API version this server serves —
// it is a v2/Embedding-API method, and this is the v1 object model. So the
// selectable set has to come from getAppliedValues(), which on this workbook
// is populated for the small categorical filters (WM_WEEK, Pickup_Type, …)
// and empty for the high-cardinality ones (Pick Date, Store #, Associate).
//
// That shapes the whole driver: scope by WM_WEEK, not by enumerating dates.
// It also happens to match how the module stores data — one document per
// (store, week) — so a week is the natural pull unit anyway.
console.log("\n→ filter capabilities + applied values:");
out.steps.domains = await page.evaluate(async (wsName) => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const active = viz.getWorkbook().getActiveSheet();
  const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  const ws = list.find((s) => (s.getName?.() || "").toLowerCase() === String(wsName).toLowerCase())
          || list.find((s) => (s.getName?.() || "").toLowerCase().includes(String(wsName).toLowerCase()))
          || list[0];
  const filters = await ws.getFiltersAsync();
  const wanted = ["Pick Date", "Store #", "WM_WEEK"];
  const res = {
    worksheet: ws.getName?.() ?? null,
    apiShape: filters.length
      ? Object.getOwnPropertyNames(Object.getPrototypeOf(filters[0])).filter((n) => n !== "constructor")
      : [],
    domains: {},
  };
  for (const f of filters) {
    const field = f.getFieldName?.();
    if (!wanted.includes(field)) continue;
    let applied = null;
    try { applied = (f.getAppliedValues?.() || []).map((v) => v.formattedValue ?? v.value); }
    catch (e) { applied = { error: String(e?.message || e) }; }
    res.domains[field] = { appliedCount: Array.isArray(applied) ? applied.length : null, applied };
  }
  return res;
}, WORKSHEET);
console.log("   worksheet: " + out.steps.domains.worksheet);
console.log("   filter methods: " + JSON.stringify(out.steps.domains.apiShape));
for (const [k, v] of Object.entries(out.steps.domains.domains || {})) {
  console.log(`   · ${k}: ${v.appliedCount} applied ${JSON.stringify((v.applied || []).slice(-8))}`);
}
save();

// Pick a week: explicit --week, else the highest numeric WM_WEEK on offer.
const weekApplied = (out.steps.domains.domains?.WM_WEEK?.applied || []).filter((v) => /^\d{6}$/.test(v));
const week = WEEK || weekApplied.sort().slice(-1)[0] || null;
if (!week) {
  out.error = "no WM_WEEK value available to scope by";
  save();
  console.error("✗ could not determine a WM_WEEK to pull. Pass --week=YYYYWW.");
  process.exit(1);
}
const dates = [];   // Pick Date left unscoped: WM_WEEK already bounds the range.
out.week = week;
console.log(`\n→ applying filters: Store # = ${STORE}, WM_WEEK = ${week}`);

// ── apply, in the order the labels demand: date first, store second ───────
out.steps.apply = await page.evaluate(async (wsName, store, dates, week) => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const active = viz.getWorkbook().getActiveSheet();
  const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  const ws = list.find((s) => (s.getName?.() || "").toLowerCase() === String(wsName).toLowerCase())
          || list.find((s) => (s.getName?.() || "").toLowerCase().includes(String(wsName).toLowerCase()))
          || list[0];
  const steps = [];
  const apply = async (field, values) => {
    const t0 = Date.now();
    try {
      await ws.applyFilterAsync(field, values, "replace");
      steps.push({ field, values, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      steps.push({ field, values, ok: false, error: String(e?.message || e), ms: Date.now() - t0 });
    }
  };
  // Order is load-bearing: the control labels say date first, store second,
  // and WM_WEEK stands in for the date scope here.
  if (dates.length) await apply("Pick Date", dates);
  if (week) await apply("WM_WEEK", [week]);
  await apply("Store #", [store]);
  return { worksheet: ws.getName?.() ?? null, steps };
}, WORKSHEET, STORE, dates, week);
out.steps.apply.steps.forEach((s) =>
  console.log(`   ${s.ok ? "✓" : "✗"} ${s.field} (${s.ms}ms)${s.error ? " — " + s.error : ""}`));
save();

// Let the viz re-query after the filter change.
console.log("\n→ waiting for re-query ...");
await sleep(8000);

// ── the payoff ────────────────────────────────────────────────────────────
console.log("→ getSummaryDataAsync after scoping:");
out.steps.summary = await page.evaluate(async (wsName) => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const active = viz.getWorkbook().getActiveSheet();
  const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  const ws = list.find((s) => (s.getName?.() || "").toLowerCase() === String(wsName).toLowerCase())
          || list.find((s) => (s.getName?.() || "").toLowerCase().includes(String(wsName).toLowerCase()))
          || list[0];
  try {
    const data = await ws.getSummaryDataAsync({ maxRows: 0, ignoreSelection: true });
    const cols = data.getColumns().map((c) => c.getFieldName());
    const raw = data.getData();
    return {
      ok: true, worksheet: ws.getName?.() ?? null, columns: cols, rowCount: raw.length,
      sample: raw.slice(0, 8).map((row) => {
        const o = {}; row.forEach((cell, i) => { o[cols[i]] = cell.formattedValue ?? cell.value; }); return o;
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}, WORKSHEET);

const s = out.steps.summary;
if (!s.ok) console.error("   ✗ " + s.error);
else {
  console.log(`   ✓ ${s.rowCount} rows from "${s.worksheet}"`);
  console.log(`   columns: ${JSON.stringify(s.columns)}`);
  s.sample.slice(0, 5).forEach((r) => console.log(`     ${JSON.stringify(r).slice(0, 260)}`));
}

save();
console.log(`\n✓ written to ${OUT}`);
await page.close();
browser.disconnect();
