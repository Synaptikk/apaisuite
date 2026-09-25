import puppeteer from "puppeteer-core";
const [START, END] = [process.argv[2] || "2026-09-15", process.argv[3] || "2026-09-22"];
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
const rows = await page.evaluate(async (bearer, START, END) => {
  const legacy = { Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "",
                   start_date: START, end_date: END, limit: "5000", offset: "0" };
  const body = { datasetId: 1716, visualizationId: 2257, dashboardId: 351,
    queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
      datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
      dashboardRunTimeParams: legacy, visualizationFilterDetails: "", nextGenSqlParams: {} },
      projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } };
  const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "t" + Date.now() }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) return { error: (j.error.message||"").slice(0,200) };
  const cols = (j.columns||[]).map(c => c.name);
  return (j.values||[]).map(v => Object.fromEntries(cols.map((k,i)=>[k, v[i]])));
}, bearer, START, END);
if (rows.error) { console.log(rows.error); process.exit(0); }
const by = new Map();
for (const r of rows) {
  const k = `${r.Invoice_Date}|${r.Trailer_Nbr}|${r.DC_Nbr}`;
  const cur = by.get(k) || { date: r.Invoice_Date, trailer: r.Trailer_Nbr, dc: r.DC_Nbr, depts: {} };
  cur.depts[r.Dept_Nbr] = (cur.depts[r.Dept_Nbr] || 0) + (r.Total_Cost_Amount || 0);
  by.set(k, cur);
}
console.log(`date       trailer   DC     depts (cost)`);
for (const v of [...by.values()].sort((a,b) => (a.date+a.trailer).localeCompare(b.date+b.trailer))) {
  console.log(`${v.date}  ${String(v.trailer).padEnd(8)} ${String(v.dc).padEnd(6)} ` +
    Object.entries(v.depts).map(([d,c]) => `${d}=$${c.toFixed(2)}`).join("  "));
}
console.log("\nDC numbers seen:", [...new Set(rows.map(r=>r.DC_Nbr))].join(", "));
await page.close(); await browser.disconnect();
