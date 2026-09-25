import puppeteer from "puppeteer-core";
const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });

// NOTE: do not call browser.pages() here — enumerating a frozen background
// tab hangs the CDP connection. Close strays via /json/close instead.

// SW code changes only take effect after a reload, and chrome.runtime.reload()
// detaches the page it is called from — so reload from a throwaway page first.
let boot = await browser.newPage();
await boot.goto(`chrome-extension://${EXT_ID}/app.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 2000));
await boot.evaluate(() => chrome.runtime.reload()).catch(() => {});
await new Promise(r => setTimeout(r, 4000));
try { await boot.close(); } catch {}

const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT_ID}/app.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

const out = await page.evaluate(async () => {
  const send = (type, payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ module: "costinventory", type, ...payload }, (res) => resolve(res ?? { ok: false, error: String(chrome.runtime.lastError?.message) }));
  });
  const t0 = Date.now();
  const res = await send("pull_trailers", { storeNbr: "1458", night: "2026-09-21" });
  return { ms: Date.now() - t0, res };
});
console.log("pull_trailers took", (out.ms / 1000).toFixed(1), "s");
console.log(JSON.stringify(out.res, null, 1).slice(0, 2500));
await page.close(); await browser.disconnect();
