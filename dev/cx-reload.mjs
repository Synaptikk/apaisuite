import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
// Open the replacement BEFORE reloading — runtime.reload() detaches the page
// handle it is called from, and closing the last tab exits Edge.
const fresh = await browser.newPage();
await fresh.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 2000));
await fresh.evaluate(() => chrome.runtime.reload()).catch(() => {});
await new Promise(r => setTimeout(r, 3500));
const page = await browser.newPage();
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
// Close the stale handles left by the reload.
for (const p of await browser.pages()) {
  if (p !== page && p.url().includes("app.html")) await p.close().catch(() => {});
}
console.log("reloaded, shell at", page.url());
await browser.disconnect();
