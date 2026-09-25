import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://hoops.wal-mart.com/ops-portal/metrics/overview?bu=1458&buType=6", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 10000));
const res = await page.evaluate(async () => {
  const call = async (proc, json) => {
    const u = `/ops-portal/v1/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json }))}`;
    const r = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
    return { status: r.status, text: await r.text() };
  };
  const out = {};
  out.base   = await call("metric.cx.comments", { buId: 1458, buType: 6, timeType: 202 });
  out.tt100  = await call("metric.cx.comments", { buId: 1458, buType: 6, timeType: 100 });
  out.tt302  = await call("metric.cx.comments", { buId: 1458, buType: 6, timeType: 302 });
  out.noTime = await call("metric.cx.comments", { buId: 1458, buType: 6 });
  return out;
});
for (const [k, v] of Object.entries(res)) {
  if (v.status !== 200) { console.log(`\n### ${k} [${v.status}] ${v.text.slice(0,300)}`); continue; }
  const j = JSON.parse(v.text).result.data.json;
  const rows = j.rows || [];
  const dates = rows.map(r => r[1]).sort();
  const trips = {}; const ratings = {};
  for (const r of rows) { trips[r[3]] = (trips[r[3]]||0)+1; ratings[r[4]] = (ratings[r[4]]||0)+1; }
  console.log(`\n### ${k}  rows=${rows.length}  dates ${dates[0]} → ${dates[dates.length-1]}  lastUpdated=${j.meta.lastUpdatedTs}`);
  console.log("  columns:", j.meta.columns.join(", "));
  console.log("  tripType:", JSON.stringify(trips));
  console.log("  rating:", JSON.stringify(ratings));
  fs.writeFileSync(`cx-hoops-comments-${k}.json`, JSON.stringify(j, null, 1));
}
await page.close(); await browser.disconnect();
