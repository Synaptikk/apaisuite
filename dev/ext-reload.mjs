// Reload the suite in the debug Edge (APAISuite-dev copy) and leave a fresh
// app.html tab open. See memory: reload from a page, open the replacement first.
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html#/digitalmetrics";
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 60000 });
let page = (await b.pages()).find((p) => p.url().startsWith("chrome-extension://fchn"));
if (!page) { page = await b.newPage(); await page.goto(APP); }
await page.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
const fresh = await b.newPage();
await fresh.goto(APP, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2000));
console.log("reloaded, v", await fresh.evaluate(() => chrome.runtime.getManifest().version),
  "hosts has my.wal-mart:", await fresh.evaluate(() => chrome.runtime.getManifest().host_permissions.includes("https://my.wal-mart.com/*")));
b.disconnect();
