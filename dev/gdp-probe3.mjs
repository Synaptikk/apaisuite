import puppeteer from "puppeteer-core";
const URL = "https://gdp-connect.walmart.com/user/projects/20/dashboards/351";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
let bearer = null;
page.on("request", r => {
  if (!bearer && /gdp\.api\.walmart\.com/.test(r.url())) {
    const a = r.headers().authorization;
    if (a) bearer = a;
  }
});
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));
if (!bearer) { console.log("NO BEARER CAPTURED"); process.exit(1); }
console.log("bearer captured, len", bearer.length);

const out = await page.evaluate(async (bearer) => {
  const base = "https://api-manager-next.gdp.api.walmart.com/v1";
  const H = { "Content-Type": "application/json", Authorization: bearer, "x-gdp-request-id": "probe-" + Date.now() };
  const apis = await (await fetch(base + "/apis/search", { method: "POST", headers: H,
    body: JSON.stringify({ searchFilters: [{ property: "projectId", operator: "=", value: 20 }], pageNumber: 0, pageSize: 50, unauthorized: false }) })).json();
  const list = (apis.result?.apis || []).map(a => ({
    apiId: a.apiId, name: a.name, desc: a.description,
    params: Object.keys(a.apiConfig?.queryParams || {}),
    sql: (a.apiConfig?.query || "").replace(/\s+/g, " ").slice(0, 900),
    vizs: (a.visualizations || []).map(v => ({ id: v.apiVisualizationId, name: v.name, type: v.visualisationType })),
  }));
  const dash = await (await fetch(base + "/dashboards/351", { headers: H })).json();
  const cfg = dash.result?.dashboardConfig || {};
  return { apis: list, cfgKeys: Object.keys(cfg), cfgSample: JSON.stringify(cfg).slice(0, 1200) };
}, bearer);
console.log("=== APIS ===\n" + JSON.stringify(out.apis, null, 1).slice(0, 9000));
console.log("=== CFG KEYS ===", out.cfgKeys.join(", "));
await page.close(); await browser.disconnect();
