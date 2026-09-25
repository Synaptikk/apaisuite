// dev/boblisa-pull-bg.mjs — ask the debug-Edge BoB and Lisa SW to pull a date range (cached per day). Usage: node dev/boblisa-pull-bg.mjs <from> <to>
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const [from, to] = process.argv.slice(2);
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 30 * 60_000 });
const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.bringToFront();
const t0 = Date.now();
const res = await page.evaluate((from, to) => new Promise((r) => chrome.runtime.sendMessage({ module: "boblisa", type: "pull_range", from, to }, r)), from, to);
console.log(`pull_range ${from}..${to} in ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(res).slice(0, 300));
await page.close(); browser.disconnect();
