import puppeteer from "puppeteer-core";
const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = await browser.newPage();
const cdp = await page.createCDPSession();
// Hand downloads back to the browser's own default location — the CDP override
// from earlier runs persists on the browser and points at a deleted directory.
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: process.argv[2], eventsEnabled: true });

await page.goto(`chrome-extension://${EXT_ID}/app.html#/costinventory`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3500));

const counts = { 93: 70123.45, 80: 15234.10, 94: 38900.00, 98: 27100.55 };
await page.evaluate((counts) => {
  for (const [dept, value] of Object.entries(counts)) {
    const i = document.querySelector(`[data-counted-dept="${dept}"]`);
    i.value = String(value); i.dispatchEvent(new Event("input", { bubbles: true }));
  }
}, counts);
await new Promise(r => setTimeout(r, 600));

// Baseline: the newest existing download id, so the poll below cannot latch
// onto a stale record from an earlier run.
const baseline = await page.evaluate(() => new Promise((resolve) => {
  chrome.downloads.search({ limit: 1, orderBy: ["-startTime"] }, (i) => resolve(i?.[0]?.id ?? 0));
}));
await page.click('[data-action="export"]');

const result = await page.evaluate((baseline) => new Promise((resolve) => {
  const deadline = Date.now() + 20000;
  const poll = () => chrome.downloads.search({ limit: 1, orderBy: ["-startTime"] }, (items) => {
    const it = items?.[0];
    if (it && it.id > baseline && it.state !== "in_progress") return resolve({ filename: it.filename, state: it.state, error: it.error, bytes: it.bytesReceived });
    if (Date.now() > deadline) return resolve({ timeout: true, last: it ?? null });
    setTimeout(poll, 500);
  });
  poll();
}), baseline);
console.log(JSON.stringify(result, null, 1));
await page.close(); await browser.disconnect();
