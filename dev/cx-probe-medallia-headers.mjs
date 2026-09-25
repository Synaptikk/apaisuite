import puppeteer from "puppeteer-core";
const URL = "https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254&fi.segment-ranker=e_walmart_voc_store_num_unit&fi.benchmark=100000105&fi.timeperiod=100000380";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const seen = [];
page.on("request", (r) => {
  if (!/api-comp\/reporting/.test(r.url())) return;
  let op = "?"; try { const j = JSON.parse(r.postData()||"{}"); op = (Array.isArray(j)?j[0]:j).operationName; } catch {}
  seen.push({ op, url: r.url(), headers: r.headers() });
});
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 180000 });
await new Promise(r => setTimeout(r, 30000));
const gc = seen.find(s => s.op === "getComments") || seen[seen.length-1];
console.log("op:", gc.op, "\nurl:", gc.url);
console.log(JSON.stringify(gc.headers, null, 1));
console.log("\nALL OPS:", seen.map(s=>s.op).join(", "));
// keep page open for the replay test
console.log("PAGE LEFT OPEN");
await browser.disconnect();
