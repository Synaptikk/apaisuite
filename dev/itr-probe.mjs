// dev/itr-probe.mjs — what does the Fresh Inventory Tracker (ops portal) serve?
import puppeteer from "puppeteer-core";
const URL = "https://hoops.wal-mart.com/ops-portal/analysis/inventory/fresh-inventory-tracker?bu=1458&buType=6&timeType=100";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const net = [];
page.on("response", async r => {
  const t = r.request().resourceType();
  if (!["xhr", "fetch"].includes(t)) return;
  let body = ""; try { body = (await r.text()).slice(0, 1500); } catch {}
  net.push({ status: r.status(), method: r.request().method(), url: r.url(),
             post: (r.request().postData()||"").slice(0,600), body: body.replace(/\s+/g," ") });
});
await page.goto(URL, { waitUntil: "networkidle2", timeout: 120000 });
await new Promise(r => setTimeout(r, 8000));
console.log("=== FINAL URL ===", page.url());
console.log("=== XHR/FETCH ===");
for (const n of net) console.log(`${n.status} ${n.method} ${n.url}\n   POST: ${n.post}\n   BODY: ${n.body.slice(0,700)}\n`);
const txt = await page.evaluate(() => (document.body.innerText||"").replace(/\n{2,}/g,"\n").slice(0, 3000));
console.log("=== PAGE TEXT ===\n" + txt);
await page.close(); await browser.disconnect();
