// Discover how Medallia serves the customer-comment feed.
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const URL = process.env.MURL || "https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254&fi.segment-ranker=e_walmart_voc_store_num_unit&fi.benchmark=100000105&fi.timeperiod=100000380";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();

const calls = [];
page.on("request", (r) => {
  const u = r.url();
  if (!/medallia/.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff2?|gif|ico)(\?|$)/.test(u)) return;
  calls.push({ phase: "req", method: r.method(), url: u, postData: r.postData()?.slice(0, 40000) || null });
});
page.on("response", async (res) => {
  const u = res.url();
  if (!/medallia/.test(u)) return;
  if (/\.(js|css|png|jpg|svg|woff2?|gif|ico)(\?|$)/.test(u)) return;
  const ct = res.headers()["content-type"] || "";
  let body = null;
  if (/json|text/.test(ct)) { try { body = (await res.text()).slice(0, 300000); } catch {} }
  calls.push({ phase: "res", status: res.status(), url: u, ct, len: body?.length ?? 0, body });
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 180000 });
await new Promise(r => setTimeout(r, 35000));

console.log("FINAL URL:", page.url());
console.log("\n=== calls ===");
for (const c of calls) {
  if (c.phase === "req") {
    if (c.method !== "GET") console.log(`REQ ${c.method} ${c.url.slice(0,160)}${c.postData ? "\n    POST: " + c.postData.slice(0,600) : ""}`);
  } else {
    console.log(`${String(c.status).padEnd(4)} ${String(c.len).padEnd(8)} ${(c.ct||"").split(";")[0].padEnd(20)} ${c.url.slice(0,170)}`);
  }
}
fs.writeFileSync(process.env.OUT || "cx-medallia-probe.json", JSON.stringify(calls, null, 1));
console.log("\nwrote", process.env.OUT || "cx-medallia-probe.json");
const text = await page.evaluate(() => document.body.innerText.slice(0, 5000));
console.log("\n=== PAGE TEXT ===\n" + text);
await page.close(); await browser.disconnect();
