// dev/costinv-probe.mjs — inspect the OneWalmart Fresh page's
// "Beginning Inventory Store Lookup Tool" to learn how it serves data.
import puppeteer from "puppeteer-core";

const URL = "https://one.walmart.com/content/uswire/en_us/work1/process-documentation/supercenters/Food-Fresh-and-Consumables/Fresh.html";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();

const net = [];
page.on("request", r => {
  const t = r.resourceType();
  if (t === "xhr" || t === "fetch" || t === "document" || t === "script") net.push(`${t.toUpperCase()} ${r.method()} ${r.url()}`);
});
page.on("response", async r => {
  const t = r.request().resourceType();
  if (t === "xhr" || t === "fetch") net.push(`  <- ${r.status()} ${r.url()}`);
});

await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await new Promise(r => setTimeout(r, 4000));

console.log("=== URL ===", page.url());
console.log("=== NETWORK (xhr/fetch/doc/script) ===");
console.log(net.filter(l => !/\.(css|png|jpg|svg|woff)/.test(l)).join("\n"));

const info = await page.evaluate(() => {
  const out = { frames: [], hits: [], scriptsWithLookup: [] };
  document.querySelectorAll("iframe").forEach(f => out.frames.push(f.src));
  // find nodes mentioning the tool
  const walker = document.evaluate("//*[contains(text(),'Beginning Inventory') or contains(text(),'Lookup Tool')]", document, null, 6, null);
  for (let i = 0; i < Math.min(walker.snapshotLength, 8); i++) {
    const n = walker.snapshotItem(i);
    out.hits.push({ tag: n.tagName, cls: n.className?.toString?.().slice(0,120), text: (n.textContent||"").trim().slice(0,160), html: n.outerHTML.slice(0, 400) });
  }
  document.querySelectorAll("script").forEach(s => {
    const txt = s.textContent || "";
    if (/inventory|lookup|storeNumber|facility/i.test(txt) && txt.length < 20000) out.scriptsWithLookup.push({ src: s.src, snippet: txt.slice(0, 600) });
    else if (s.src && /inventory|lookup|tool/i.test(s.src)) out.scriptsWithLookup.push({ src: s.src, snippet: "(external)" });
  });
  return out;
});
console.log("=== IFRAMES ===\n" + info.frames.join("\n"));
console.log("=== TEXT HITS ===\n" + JSON.stringify(info.hits, null, 1));
console.log("=== SCRIPTS ===\n" + JSON.stringify(info.scriptsWithLookup.slice(0,6), null, 1));

await page.close();
await browser.disconnect();
