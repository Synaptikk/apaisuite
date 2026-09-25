import puppeteer from "puppeteer-core";
const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT_ID}/app.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 2000));
const out = await page.evaluate(async () => {
  const all = await chrome.storage.session.get("costinventory.gdp.bearer");
  const bearer = all["costinventory.gdp.bearer"]?.value;
  const legacy = { Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "'322594','309178'",
                   start_date: "2026-09-07", end_date: "2026-09-24", limit: "5000", offset: "0" };
  const body = JSON.stringify({ datasetId: 1727, visualizationId: 2268, dashboardId: 351,
    queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
      dashboardRunTimeParams: legacy,
      datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
      visualizationFilterDetails: "", nextGenSqlParams: {} },
      projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } });
  const url = "https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query";

  const attempt = async (label, init) => {
    try {
      const r = await fetch(url, init);
      const t = await r.text();
      return { label, status: r.status, body: t.slice(0, 120).replace(/\s+/g, " ") };
    } catch (e) { return { label, err: String(e).slice(0, 120) }; }
  };

  return [
    await attempt("full headers (as module)", { method: "POST", body,
      headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "apaisuite-1" } }),
    await attempt("no x-gdp-request-id", { method: "POST", body,
      headers: { "Content-Type": "application/json", Authorization: bearer } }),
    await attempt("credentials omit", { method: "POST", body, credentials: "omit",
      headers: { "Content-Type": "application/json", Authorization: bearer } }),
    await attempt("bearer len check", { method: "POST", body: JSON.stringify({ ping: 1 }),
      headers: { "Content-Type": "application/json", Authorization: bearer } }),
  ];
});
console.log(JSON.stringify(out, null, 1));
await page.close(); await browser.disconnect();
