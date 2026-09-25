import puppeteer from "puppeteer-core";
const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1200 });
await page.goto(`chrome-extension://${EXT_ID}/app.html#/costinventory`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
await page.evaluate(() => {
  const counts = { 93: 70123.45, 80: 15234.10, 94: 38900.00, 98: 27100.55 };
  for (const [d, v] of Object.entries(counts)) {
    const i = document.querySelector(`[data-counted-dept="${d}"]`);
    if (i) { i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); }
  }
});
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: process.argv[2], fullPage: true });
console.log("shot saved");
await page.close(); await browser.disconnect();
