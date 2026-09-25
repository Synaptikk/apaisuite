import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
const out = await page.evaluate(async (bearer) => {
  const post = async (label, body) => {
    const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "p" + Date.now() },
      body: JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    if (!j) return { label, status: r.status, raw: t.slice(0,200) };
    if (j.error) return { label, status: r.status, error: (j.error.message||"").slice(0, 220) };
    return { label, status: r.status, columns: (j.columns||[]).map(c=>c.name), rows: (j.values||[]).length, sample: (j.values||[]).slice(0,8) };
  };
  const mk = (datasetId, visualizationId, legacy) => ({ datasetId, visualizationId, dashboardId: 351,
    queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
      datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
      dashboardRunTimeParams: legacy, visualizationFilterDetails: "", nextGenSqlParams: {} },
      projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } });
  const base = { Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "", start_date: "2026-09-15", end_date: "2026-09-22" };
  return [
    await post("1727 limit in legacy (string)", mk(1727, 2268, { ...base, limit: "500", offset: "0" })),
    await post("1727 limit numeric", mk(1727, 2268, { ...base, limit: 500, offset: 0 })),
    await post("1716 limit in legacy", mk(1716, 2257, { ...base, limit: "500", offset: "0" })),
    await post("126 detail limit in legacy", mk(126, 225, { ...base, limit: "5", offset: "0" })),
  ];
}, bearer);
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
await page.close(); await browser.disconnect();
