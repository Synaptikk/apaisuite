// Can a SW-style fetch of the page HTML find the current month's toolId?
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 2000));
const out = await page.evaluate(async () => {
  const r = await fetch("/content/uswire/en_us/work1/merchandise/fresh.html", { credentials: "include" });
  const html = await r.text();
  // find every lookup tool table and its headers
  const tools = [];
  for (const m of html.matchAll(/<table[^>]*id="([0-9a-f]{32})"[^>]*>([\s\S]{0,1200}?)<\/thead>/g)) {
    const headers = [...m[2].matchAll(/<th>([\s\S]*?)<\/th>/g)].map(h => h[1].replace(/<[^>]*>/g, "").trim());
    tools.push({ id: m[1], headers });
  }
  // the heading text that sits before each tool
  const headings = [...html.matchAll(/Beginning Inventory Store Lookup Tool[^<]{0,40}/g)].map(x => x[0]);
  return { status: r.status, len: html.length, tools, headings };
});
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
await page.close(); await browser.disconnect();
