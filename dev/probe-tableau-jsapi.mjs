// dev/probe-tableau-jsapi.mjs
//
// Does the Tableau EMBEDDING JS API actually yield data on the
// StoreFulfillmentScorecard workbook?
//
// dev/probe-tableau-view.mjs established that window.tableau.VizManager exists
// in the TOP frame of this view and reports 1 viz — unlike the VizPick
// workbook, where dev/VIZPICK_EXPORT_FINDINGS.md had to fall back to driving
// the crosstab export. If the JS API returns real summary rows here, the
// digitalmetrics driver is a few hundred lines instead of vizpick's 1,620.
//
// This probe runs EXACTLY what modules/digitalmetrics/content/tableau_capture.js
// does, so a pass here means that content script is viable as written.
//
//   node dev/probe-tableau-jsapi.mjs
//   node dev/probe-tableau-jsapi.mjs --worksheet="Associate Performance"
//
// Read-only: enumerates sheets and calls getSummaryDataAsync. Applies no
// filters and changes no state.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const wsArg = process.argv.find((a) => a.startsWith("--worksheet="));
const WORKSHEET = wsArg ? wsArg.split("=").slice(1).join("=") : null;

const URL_ = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance?:iid=1&:linktarget=_self";
const OUT = resolve(HERE, "tableau-jsapi-probe.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { url: URL_, startedAt: new Date().toISOString() };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}\n  Run ./dev/launch-edge-debug.sh`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60_000 });

// Wait for the JS API to register a viz, rather than a fixed sleep.
console.log("→ waiting for VizManager to register a viz ...");
const ready = await page.waitForFunction(
  () => { try { return (window.tableau?.VizManager?.getVizs?.() || []).length > 0; } catch { return false; } },
  { timeout: 120_000, polling: 500 },
).then(() => true).catch(() => false);

if (!ready) {
  out.error = "VizManager never registered a viz within 120s";
  save();
  console.error("✗ " + out.error);
  process.exit(1);
}
console.log("✓ viz registered");
await sleep(3000);

// ── enumerate sheets exactly as the content script does ───────────────────
console.log("\n→ sheet structure:");
out.sheets = await page.evaluate(() => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const wb = viz.getWorkbook?.();
  const active = wb?.getActiveSheet?.();
  if (!active) return { error: "no active sheet" };
  const type = active.getSheetType?.();
  const list = type === "dashboard" ? (active.getWorksheets?.() || []) : [active];
  return {
    workbookName: wb?.getName?.() ?? null,
    activeSheetName: active.getName?.() ?? null,
    activeSheetType: type ?? null,
    worksheets: list.map((s) => ({ name: s.getName?.() ?? null, type: s.getSheetType?.() ?? null })),
  };
});
console.log("   " + JSON.stringify(out.sheets, null, 2).split("\n").join("\n   "));
save();

if (out.sheets.error) { console.error("✗ " + out.sheets.error); process.exit(1); }

// ── filters visible through the API (names must match the DOM probe) ──────
console.log("\n→ filters via API, per worksheet:");
out.filters = await page.evaluate(async (want) => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const wb = viz.getWorkbook();
  const active = wb.getActiveSheet();
  const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  const target = want
    ? list.filter((s) => (s.getName?.() || "").toLowerCase().includes(String(want).toLowerCase()))
    : list;
  const res = [];
  for (const s of target) {
    try {
      const fs = await s.getFiltersAsync();
      res.push({
        worksheet: s.getName?.() ?? null,
        filters: fs.map((f) => ({
          field: f.getFieldName?.() ?? null,
          type: f.getFilterType?.() ?? null,
          values: (() => {
            try { return (f.getAppliedValues?.() || []).slice(0, 8).map((v) => v.formattedValue ?? v.value); }
            catch { return null; }
          })(),
        })),
      });
    } catch (e) {
      res.push({ worksheet: s.getName?.() ?? null, error: String(e?.message || e) });
    }
  }
  return res;
}, WORKSHEET);
for (const w of out.filters) {
  console.log(`   · ${w.worksheet}${w.error ? "  ERROR: " + w.error : ""}`);
  for (const f of w.filters || []) console.log(`       ${f.field}  [${f.type}]  ${JSON.stringify(f.values)}`);
}
save();

// ── THE test: does summary data come back? ────────────────────────────────
console.log("\n→ getSummaryDataAsync (maxRows 200, this is the decisive test):");
out.summary = await page.evaluate(async (want) => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const wb = viz.getWorkbook();
  const active = wb.getActiveSheet();
  const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  const results = [];
  for (const s of list) {
    const name = s.getName?.() ?? null;
    if (want && !name?.toLowerCase().includes(String(want).toLowerCase())) continue;
    try {
      const data = await s.getSummaryDataAsync({ maxRows: 200, ignoreSelection: true });
      const cols = data.getColumns().map((c) => c.getFieldName());
      const raw = data.getData();
      const rows = raw.slice(0, 5).map((row) => {
        const o = {};
        row.forEach((cell, i) => { o[cols[i]] = cell.formattedValue ?? cell.value; });
        return o;
      });
      results.push({ worksheet: name, ok: true, columns: cols, rowCount: raw.length, sample: rows });
    } catch (e) {
      results.push({ worksheet: name, ok: false, error: String(e?.message || e) });
    }
  }
  return results;
}, WORKSHEET);

for (const r of out.summary) {
  if (!r.ok) { console.log(`   ✗ ${r.worksheet}: ${r.error}`); continue; }
  console.log(`   ✓ ${r.worksheet}: ${r.rowCount} rows`);
  console.log(`     columns: ${JSON.stringify(r.columns)}`);
  r.sample.slice(0, 3).forEach((s) => console.log(`       ${JSON.stringify(s).slice(0, 240)}`));
}

save();
console.log(`\n✓ written to ${OUT}`);
await page.close();
browser.disconnect();
