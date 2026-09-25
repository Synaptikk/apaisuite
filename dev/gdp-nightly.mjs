import puppeteer from "puppeteer-core";
const [START, END] = [process.argv[2] || "2026-09-21", process.argv[3] || "2026-09-21"];
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
const rows = await page.evaluate(async (bearer, START, END) => {
  const legacy = { Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "",
                   start_date: START, end_date: END, limit: "500", offset: "0" };
  const body = { datasetId: 1727, visualizationId: 2268, dashboardId: 351,
    queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
      datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
      dashboardRunTimeParams: legacy, visualizationFilterDetails: "", nextGenSqlParams: {} },
      projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } };
  const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "n" + Date.now() },
    body: JSON.stringify(body) });
  const j = await r.json();
  const c = (j.columns||[]).map(x => x.name);
  return (j.values||[]).map(v => Object.fromEntries(c.map((k,i)=>[k, v[i]])));
}, bearer, START, END);
const by = new Map();
for (const r of rows) {
  const k = r.DEPT_NUMBER;
  const cur = by.get(k) || { dept: k, cost: 0, freight: 0, trailers: new Set() };
  cur.cost += r.Total_Cost || 0; cur.freight += r.freight_charges || 0;
  cur.trailers.add(r.Trailer_Number);
  by.set(k, cur);
}
console.log(`store 1458  invoice date ${START}..${END}   (${rows.length} rows)`);
console.log("dept |    Total_Cost |   freight |  cost+freight | trailers");
for (const d of [80, 93, 94, 98]) {
  const v = by.get(d); if (!v) { console.log(`${d}   |  (no rows)`); continue; }
  console.log(`${d}   | ${v.cost.toFixed(2).padStart(13)} | ${v.freight.toFixed(2).padStart(9)} | ${(v.cost+v.freight).toFixed(2).padStart(13)} | ${[...v.trailers].join(", ")}`);
}
await page.close(); await browser.disconnect();
