import puppeteer from "puppeteer-core";
const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT_ID}/app.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 2500));
const out = await page.evaluate(async () => {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => /bearer|token|gdp/i.test(k))
    .map(([k, v]) => ({ key: k, type: typeof v, len: (v?.value ?? "").length,
                        head: String(v?.value ?? "").slice(0, 60),
                        tail: String(v?.value ?? "").slice(-30),
                        at: v?.at ?? null }));
});
console.log(JSON.stringify(out, null, 1));
await page.close(); await browser.disconnect();
