import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
const out = await page.evaluate(async (bearer) => {
  const run = async (label, datasetId, visualizationId, legacy, extra = {}) => {
    const body = { datasetId, visualizationId, dashboardId: 351,
      queryExecutionRequest: { queryParams: { nextGenFilters: "", legacyParams: legacy,
        datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
        dashboardRunTimeParams: { ...legacy, limit: "500", offset: "0" },
        visualizationFilterDetails: "", nextGenSqlParams: {}, ...extra },
        projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" } };
    const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "p" + Date.now() },
      body: JSON.stringify(body) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!j) return { label, status: r.status, raw: t.slice(0, 400) };
    if (j.error) return { label, status: r.status, error: JSON.stringify(j.error).slice(0, 500) };
    return { label, status: r.status, columns: (j.columns||[]).map(c=>c.name), rowCount: (j.values||[]).length, sample: (j.values||[]).slice(0,6) };
  };
  const L = (o) => ({ Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "", start_date: "", end_date: "", ...o });
  return [
    await run("1727 store only", 1727, 2268, L({})),
    await run("1727 store+dates", 1727, 2268, L({ start_date: "2026-09-20", end_date: "2026-09-22" })),
    await run("1716 store+dates", 1716, 2257, L({ start_date: "2026-09-20", end_date: "2026-09-22" })),
    await run("1716 store+dept+dates", 1716, 2257, L({ Dept_Nbr: "93", start_date: "2026-09-20", end_date: "2026-09-22" })),
  ];
}, bearer);
console.log(JSON.stringify(out, null, 1).slice(0, 5000));
await page.close(); await browser.disconnect();
