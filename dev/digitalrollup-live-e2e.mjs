// dev/digitalrollup-live-e2e.mjs
//
// Reloads the suite in the debug Edge, opens Digital Market Rollup, and reads
// the home store's "picked last hour" line and the Live toggle state a few
// times over a couple of minutes, so live ticks can be seen landing.
//
//   node dev/digitalrollup-live-e2e.mjs [minutes=3]
//
// Mirror modules/digitalrollup into APAISuite-dev first (see MEMORY.md).
import puppeteer from "puppeteer-core";

const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const APP = `chrome-extension://${EXT_ID}/app.html`;
const minutes = Number(process.argv[2] || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
let page = (await browser.pages()).find((p) => p.url().startsWith(APP));
if (!page) { page = await browser.newPage(); await page.goto(APP, { waitUntil: "domcontentloaded" }); }

// Reload from the PAGE context (SW evaluate hangs in this Edge), and open the
// replacement before closing the stale handle so Edge never loses its last tab.
const stale = page;
await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
await sleep(3000);
page = await browser.newPage();
await page.bringToFront();
await page.goto(`${APP}#/digitalrollup`, { waitUntil: "domcontentloaded" });
if (stale !== page) await stale.close().catch(() => {});
await page.waitForSelector(".dmr-store-card", { timeout: 60_000 });

const read = () => page.evaluate(async () => {
  const home = document.querySelector(".dmr-store-card.is-home");
  const live = document.querySelector("[data-live-wrap]");
  const st = await chrome.runtime.sendMessage({ module: "digitalrollup", type: "get_state" });
  const hist = (await chrome.storage.local.get("digitalrollup.pickHistory.v1"))["digitalrollup.pickHistory.v1"];
  return {
    at: new Date().toLocaleTimeString(),
    homeCard: home?.dataset.store ?? null,
    hourLine: home?.querySelector(".dmr-hour")?.innerText.replace(/\s+/g, " ") ?? null,
    hourTitle: home?.querySelector(".dmr-hour")?.title ?? null,
    hourLinesOnPage: document.querySelectorAll(".dmr-hour").length,
    live: { label: live?.innerText.trim(), state: live?.dataset.liveState, title: live?.title },
    rolling: st?.rolling ?? st?.data?.rolling,
    tracked: hist ? Object.fromEntries(Object.entries(hist.series).map(([k, v]) => [k, v.slice(-3)])) : null,
  };
});

const end = Date.now() + minutes * 60_000;
while (true) {
  console.log(JSON.stringify(await read()));
  if (Date.now() > end) break;
  await sleep(65_000);
}
await page.screenshot({ path: process.env.SHOT || "digitalrollup-live.png" });
browser.disconnect();
