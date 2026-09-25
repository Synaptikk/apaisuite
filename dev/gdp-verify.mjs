import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
const out = await page.evaluate(async (bearer) => {
  const run = async (datasetId, visualizationId, legacy) => {
    const body = { datasetId, visualizationId, dashboardId: 351,
      queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
        datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
        dashboardRunTimeParams: legacy, visualizationFilterDetails: "", nextGenSqlParams: {} },
        projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } };
    const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "v" + Date.now() }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) return { error: (j.error.message||"").slice(0,200) };
    const cols = (j.columns||[]).map(c => c.name);
    return { cols, rows: (j.values||[]).map(v => Object.fromEntries(cols.map((k,i)=>[k, v[i]]))) };
  };
  const D = "2026-09-20";
  // detail rows, store 1458 dept 93 trailer 309178 on that invoice date
  const detail = await run(126, 225, { Store_Nbr: "1458", Dept_Nbr: "93", Invoice_Nbr: "", Trailer_Nbr: "'309178'",
                                       start_date: D, end_date: D, limit: "10000", offset: "0" });
  // the aggregate the module would use
  const agg = await run(1727, 2268, { Store_Nbr: "1458", Dept_Nbr: "93", Invoice_Nbr: "", Trailer_Nbr: "'309178'",
                                      start_date: D, end_date: D, limit: "500", offset: "0" });
  return { detail, agg };
}, bearer);
if (out.detail.error || out.agg.error) { console.log(JSON.stringify(out, null, 1).slice(0, 800)); process.exit(0); }
const rows = out.detail.rows;
const costKey = out.detail.cols.find(c => /^cost/i.test(c));
const sum = rows.reduce((s, r) => s + Number(r[costKey] || 0), 0);
const invoices = [...new Set(rows.map(r => r.Invoice_Nbr))];
console.log("DETAIL (dataset 126)");
console.log("  columns:", out.detail.cols.join(", "));
console.log("  rows:", rows.length, " invoices:", invoices.join(", "));
console.log("  sum of", costKey, "=", sum.toFixed(2));
console.log("  first 3 cost values:", rows.slice(0,3).map(r=>r[costKey]).join(", "));
console.log("\nAGGREGATE (dataset 1727)");
for (const r of out.agg.rows) console.log("  ", JSON.stringify(r));
await page.close(); await browser.disconnect();
