// Prove the re-anchor path: kill the Medallia anchor out from under a running
// pull and confirm the pull still finishes.
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 900000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));

// Wipe history so this is a real full pull with several pages to interrupt.
await page.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ module: "cx", type: "clearHistory" }, res)));
console.log("history cleared");

const t0 = Date.now();
const pull = page.evaluate(() => new Promise((res) =>
  chrome.runtime.sendMessage({ module: "cx", type: "refresh", mode: "full" }, res)));

// Once the pull is under way, close its anchor tab — the harshest version of
// "the tab went away", which a freeze looks like from the SW's side.
await new Promise(r => setTimeout(r, 45000));
const victims = (await browser.pages()).filter(p => /walmart\.medallia\.com/.test(p.url()));
console.log(`killing ${victims.length} medallia tab(s) mid-pull at ${Math.round((Date.now()-t0)/1000)}s`);
for (const v of victims) await v.close().catch(() => {});

const outcome = await pull;
console.log(`pull finished in ${Math.round((Date.now()-t0)/1000)}s`);
console.log("  hoops   :", JSON.stringify(outcome.hoops));
console.log("  medallia:", JSON.stringify(outcome.medallia));
const after = await page.evaluate(async () => {
  const b = (await chrome.storage.local.get("cx.comments.v1"))["cx.comments.v1"];
  return b ? { records: b.records.length, from: b.from, to: b.to } : null;
});
console.log("  stored  :", JSON.stringify(after));
console.log(outcome.medallia?.ok && after?.records > 7000 ? "PASS — survived losing its anchor" : "FAIL");
await browser.disconnect();
