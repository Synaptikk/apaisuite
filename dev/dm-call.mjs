// Send one digitalmetrics message from the debug Edge's open suite page.
// Usage: node dm-call.mjs <type> '<json payload>'
import puppeteer from "puppeteer-core";
const [type, json = "{}"] = process.argv.slice(2);
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 300000 });
let page = (await b.pages()).find((p) => /\/app\.html/.test(p.url()) && p.url().startsWith("chrome-extension://fchn"));
if (!page) {
  page = await b.newPage();
  await page.goto("chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html#/digitalmetrics");
}
const r = await page.evaluate((type, payload) =>
  chrome.runtime.sendMessage({ module: "digitalmetrics", type, ...payload }), type, JSON.parse(json));
console.log(JSON.stringify(r));
b.disconnect();
