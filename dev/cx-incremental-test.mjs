// The daily path: a Refresh on top of existing history should read only the
// overlap window, add nothing new, and leave the record count unchanged.
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
await page.bringToFront().catch(() => {});
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

const before = await page.evaluate(async () => {
  const b = (await chrome.storage.local.get("cx.comments.v1"))["cx.comments.v1"];
  return { records: b.records.length, from: b.from, to: b.to };
});
console.log("before:", JSON.stringify(before));

const t0 = Date.now();
const outcome = await page.evaluate(() => new Promise((res) =>
  chrome.runtime.sendMessage({ module: "cx", type: "refresh", mode: "incremental" }, res)));
console.log(`incremental refresh: ${Math.round((Date.now()-t0)/1000)}s`);
console.log("  hoops   :", JSON.stringify(outcome.hoops));
console.log("  medallia:", JSON.stringify(outcome.medallia));

const after = await page.evaluate(async () => {
  const b = (await chrome.storage.local.get("cx.comments.v1"))["cx.comments.v1"];
  return { records: b.records.length, from: b.from, to: b.to };
});
console.log("after :", JSON.stringify(after));
console.log(after.records === before.records ? "PASS — no duplicates, count unchanged" : `count moved ${before.records} → ${after.records}`);

// And the analysis still builds on the merged set.
const a = await page.evaluate(() => new Promise((res) =>
  chrome.runtime.sendMessage({ module: "cx", type: "analyze" }, res)));
console.log("analyze:", a.ok, "| filtered", a.analysis?.counts.filtered, "| themes", a.analysis?.themes.all.length,
            "| movers", a.analysis?.movement.movers.length);
await browser.disconnect();
