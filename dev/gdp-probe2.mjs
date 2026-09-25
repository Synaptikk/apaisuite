import puppeteer from "puppeteer-core";
const URL = "https://gdp-connect.walmart.com/user/projects/20/dashboards/351";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const hdrs = [];
page.on("request", r => {
  if (/api-manager-next.*execute-query|api-manager-next.*apis\/search/.test(r.url())) {
    const h = r.headers();
    hdrs.push({ url: r.url().slice(0, 90), auth: h.authorization ? h.authorization.slice(0, 40) + "..." : null,
      keys: Object.keys(h).filter(k => !/^(accept|accept-encoding|accept-language|content-length|origin|referer|sec-|user-agent|content-type)/.test(k)) });
  }
});
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 8000));
console.log("=== AUTH HEADERS ON API CALLS ===\n" + JSON.stringify(hdrs.slice(0,3), null, 1));

const out = await page.evaluate(async () => {
  const base = "https://api-manager-next.gdp.api.walmart.com/v1";
  const dash = await (await fetch(base + "/dashboards/351", { credentials: "include" })).json();
  const cfg = dash.result?.dashboardConfig || {};
  const widgets = (cfg.visualizations || cfg.widgets || []).map(w => ({
    name: w.name || w.apiVisualizationConfig?.vizName, apiIds: w.apiIds, vizId: w.apiVisualizationId,
    type: w.visualisationType || w.componentId,
  }));
  const apiIds = [...new Set((cfg.visualizations||[]).flatMap(w => w.apiIds || []))];
  const apis = await (await fetch(base + "/apis/search", { method: "POST", credentials: "include",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ searchFilters: [{ property: "projectId", operator: "=", value: 20 }], pageNumber: 0, pageSize: 50, unauthorized: false }) })).json();
  const queries = (apis.result?.apis || []).map(a => ({ apiId: a.apiId, name: a.name, desc: a.description,
      sql: (a.apiConfig?.query || "").replace(/\s+/g, " ").slice(0, 700),
      vizIds: (a.visualizations||[]).map(v => v.apiVisualizationId) }));
  return { keys: Object.keys(cfg), widgets, apiIds, queries };
});
console.log("=== DASHBOARD CONFIG KEYS ===", out.keys.join(", "));
console.log("=== WIDGETS ===\n" + JSON.stringify(out.widgets, null, 1).slice(0, 2500));
console.log("=== QUERIES ===\n" + JSON.stringify(out.queries, null, 1).slice(0, 7000));
await page.close(); await browser.disconnect();
