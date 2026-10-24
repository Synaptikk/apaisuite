// dm-call with a targetFilter so frozen tabs can't hang connect.
import puppeteer from "puppeteer-core";
const [type, json = "{}"] = process.argv.slice(2);
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 300000,
  targetFilter: (t) => t.type === "page" && t.url.includes("fchnolphfaklbpdgnofhblfhcailkpdb/app.html") });
const t = await b.waitForTarget((t) => t.url().includes("app.html"), { timeout: 10000 });
const page = (await t.page()) || (await t.asPage());
const r = await page.evaluate((type, payload) =>
  chrome.runtime.sendMessage({ module: "digitalmetrics", type, ...payload }), type, JSON.parse(json));
console.log(JSON.stringify(r));
b.disconnect();
