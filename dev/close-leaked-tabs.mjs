import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 60000 });
const pages = await browser.pages();
let closed = 0;
for (const p of pages) {
  let url = ""; try { url = p.url(); } catch {}
  if (/gdp-connect\.walmart\.com/.test(url)) { await p.close().catch(() => {}); closed++; }
}
console.log("closed", closed, "gdp tabs");
await browser.disconnect();
