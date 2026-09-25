import puppeteer from "puppeteer-core";
const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT_ID}/app.html#/costinventory`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3500));

// click export, then ask the downloads API what happened
await page.evaluate(() => {
  const inp = document.querySelector('[data-counted-dept="93"]');
  if (inp) { inp.value = "70000"; inp.dispatchEvent(new Event("input", { bubbles: true })); }
});
await page.click('[data-action="export"]').catch(e => console.log("click failed:", String(e).slice(0,120)));
await new Promise(r => setTimeout(r, 4000));

const recent = await page.evaluate(() => new Promise((resolve) => {
  chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] }, (items) => resolve(
    (items || []).map(i => ({ filename: i.filename, state: i.state, error: i.error, bytes: i.bytesReceived, start: i.startTime }))));
}));
console.log(JSON.stringify(recent, null, 1));
await page.close(); await browser.disconnect();
