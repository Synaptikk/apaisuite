import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => { if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) { const a = r.headers().authorization; if (a) bearer = a; } });
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
if (!bearer) { console.log("NO BEARER"); process.exit(1); }

const out = await page.evaluate(async (bearer) => {
  const run = async (label, legacy) => {
    const body = {
      datasetId: 1727, visualizationId: 2268, dashboardId: 351,
      queryExecutionRequest: { queryParams: {
        nextGenFilters: "",
        legacyParams: legacy,
        datasource: { project: "bq_us_gg_shrnk_prod", datasourceType: "BIGQUERY" },
        dashboardRunTimeParams: { ...legacy, limit: "500", offset: "0" },
        visualizationFilterDetails: "", nextGenSqlParams: {},
      }, projectId: 20, datasourceType: "BIGQUERY", daasDatasourceId: "bq_us_gg_shrnk_prod" },
    };
    const r = await fetch("https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "probe-" + Date.now() },
      body: JSON.stringify(body) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { return { label, status: r.status, raw: t.slice(0, 300) }; }
    return { label, status: r.status, columns: (j.columns||[]).map(c=>c.name), rowCount: (j.values||[]).length,
             rows: (j.values||[]).slice(0, 12), err: j.error ? String(j.error).slice(0,200) : undefined };
  };
  const yday = "2026-09-21";
  return {
    a: await run("blank dept+trailer, yesterday", { Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "", start_date: yday, end_date: yday }),
    b: await run("fresh depts, blank trailer, yesterday", { Store_Nbr: "1458", Dept_Nbr: "80,93,94,98", Invoice_Nbr: "", Trailer_Nbr: "", start_date: yday, end_date: yday }),
    c: await run("blank dept+trailer, last 7d", { Store_Nbr: "1458", Dept_Nbr: "", Invoice_Nbr: "", Trailer_Nbr: "", start_date: "2026-09-15", end_date: "2026-09-22" }),
  };
}, bearer);
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
await page.close(); await browser.disconnect();
