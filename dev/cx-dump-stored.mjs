// Dump the module's stored comment history out of the extension so the topic
// audit can run against the full 52 weeks, not just the probe's 90 days.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html"));
if (!page) { console.log("no shell tab open"); process.exit(1); }
const box = await page.evaluate(async () => (await chrome.storage.local.get("cx.comments.v1"))["cx.comments.v1"]);
fs.writeFileSync(process.argv[2] || "cx-stored.json", JSON.stringify(box));
console.log(`dumped ${box.records.length} records ${box.from} → ${box.to}`);
await browser.disconnect();
