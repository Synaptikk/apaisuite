// dev/probe-tableau-express.mjs
//
// Discovery probe for StoreFulfillmentScorecard / MetricOverviewandHourly —
// the view that carries Express pickup order/pick counts. Read-only.
//
//   node dev/probe-tableau-express.mjs [store] [isoDate]
//
// Opens the view in the debug Edge (CDP 9222) with the same URL-parameter
// scoping the digitalmetrics pull uses, then dumps: worksheets, filters (with
// applied values), workbook parameters, and the summary columns + first rows
// of every worksheet. Output lands in a *-probe.json (gitignored).

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const QS = process.argv[2] || "STORE=1458";


const URL_ = `https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/MetricOverviewandHourly` +
  `?:iid=1&:linktarget=_self&${QS}`;
const OUT = resolve(HERE, `tableau-MetricOverviewandHourly-probe.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300_000 });
const page = await browser.newPage();
console.log("→", URL_);
await page.goto(URL_, { waitUntil: "load", timeout: 90_000 }).catch((e) => console.log("goto:", e.message));

const ready = () => {
  try {
    const v = window.tableau?.VizManager?.getVizs?.()?.[0];
    const a = v?.getWorkbook?.()?.getActiveSheet?.();
    if (!a) return false;
    const s = a.getSheetType?.() === "dashboard" ? a.getWorksheets?.() : [a];
    return Array.isArray(s) && s.length > 0;
  } catch { return false; }
};
const t0 = Date.now();
while (Date.now() - t0 < 150_000) {
  if (await page.evaluate(ready).catch(() => false)) break;
  await sleep(1500);
}
console.log(`viz ready after ${Math.round((Date.now() - t0) / 1000)}s; settling…`);
await sleep(8000);

const dump = await page.evaluate(async () => {
  const out = { url: location.href, sheets: [], parameters: [], errors: [] };
  const viz = window.tableau.VizManager.getVizs()[0];
  const wb = viz.getWorkbook();
  const active = wb.getActiveSheet();
  out.activeSheet = { name: active.getName?.(), type: active.getSheetType?.() };
  try {
    const params = await wb.getParametersAsync();
    out.parameters = params.map((p) => ({
      name: p.getName?.(), current: p.getCurrentValue?.()?.formattedValue ?? p.getCurrentValue?.(),
      dataType: p.getDataType?.(), allowable: p.getAllowableValuesType?.(),
      values: (p.getAllowableValues?.() || []).map((v) => v.formattedValue ?? v.value).slice(0, 40),
      min: p.getMinValue?.()?.formattedValue, max: p.getMaxValue?.()?.formattedValue,
    }));
  } catch (e) { out.errors.push("params: " + (e?.message ?? e)); }
  const sheets = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  for (const ws of sheets) {
    const s = { name: ws.getName?.(), filters: [], columns: [], rows: [], rowCount: null };
    try {
      const fl = await ws.getFiltersAsync();
      s.filters = fl.map((f) => {
        const o = { field: f.getFieldName?.(), type: f.getFilterType?.() };
        try { o.applied = (f.getAppliedValues?.() || []).map((v) => v.formattedValue ?? v.value).slice(0, 20); } catch {}
        try { o.excludeMode = f.getIsExcludeMode?.(); o.all = f.getIsAllSelected?.(); } catch {}
        try { o.min = f.getMin?.(); o.max = f.getMax?.(); } catch {}
        return o;
      });
    } catch (e) { s.filterError = String(e?.message ?? e); }
    try {
      const data = await ws.getSummaryDataAsync({ maxRows: 0, ignoreSelection: true });
      s.columns = data.getColumns().map((c) => c.getFieldName());
      const all = data.getData();
      s.rowCount = all.length;
      s.rows = all.slice(0, 40).map((r) => Object.fromEntries(r.map((c, i) => [s.columns[i], c.formattedValue ?? c.value])));
    } catch (e) { s.dataError = String(e?.message ?? e); }
    out.sheets.push(s);
  }
  return out;
});
writeFileSync(OUT, JSON.stringify(dump, null, 2));
console.log("active:", JSON.stringify(dump.activeSheet));
console.log("parameters:", dump.parameters.map((p) => `${p.name}=${p.current} [${p.dataType}/${p.allowable}${p.values?.length ? " " + p.values.join("|") : ""}${p.min != null ? ` ${p.min}..${p.max}` : ""}]`).join("\n  "));
for (const s of dump.sheets) {
  console.log(`\n## ${JSON.stringify(s.name)} rows=${s.rowCount} ${s.dataError || ""}`);
  console.log("  cols:", s.columns.join(" | "));
  console.log("  filters:", s.filters.map((f) => `${f.field}(${f.type})${f.applied?.length ? "=" + f.applied.join(",") : ""}${f.min != null ? ` ${JSON.stringify(f.min)}..${JSON.stringify(f.max)}` : ""}`).join("; "));
  for (const r of s.rows.slice(0, 6)) console.log("  ", JSON.stringify(r));
}
if (dump.errors.length) console.log("errors:", dump.errors);
await page.close();
browser.disconnect();
