// The dashboard carries a store ranker (`fi.segment-ranker=e_walmart_voc_store_num_unit`).
// Let the app render it and read the rows: whatever stores it lists are the
// stores this role can see. No schema guessing.
import puppeteer from "puppeteer-core";
const URL = "https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899"
  + "?roleId=251254&fi.segment-ranker=e_walmart_voc_store_num_unit&fi.benchmark=100000105&fi.timeperiod=100000380";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 200000 });
const page = await browser.newPage();

// Capture what the ranker module asks for and what comes back.
const payloads = [];
page.on("response", async (res) => {
  if (!/api-comp\/reporting/.test(res.url())) return;
  try {
    const body = await res.text();
    if (/store_num_unit/.test(body) && body.length > 500) payloads.push(body);
  } catch { /* ignore */ }
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 180000 });
await new Promise(r => setTimeout(r, 30000));

// Any store numbers rendered anywhere on the page?
const onPage = await page.evaluate(() => {
  const text = document.body.innerText;
  const stores = [...new Set((text.match(/\b(\d{3,4})\s*-\s*[A-Z][A-Z ]{3,}/g) || []))].slice(0, 20);
  return { stores, hasRanker: /rank/i.test(text) };
});
console.log("store-like labels rendered:", JSON.stringify(onPage.stores));

// And in the raw responses, which store units appear?
const found = new Set();
for (const b of payloads) {
  for (const m of b.matchAll(/"(\d{3,4}) - ([A-Z][A-Za-z .'-]+) - ([A-Z]{2})"/g)) found.add(m[1]);
}
console.log("store numbers seen in ranker responses:", [...found].sort().join(", ") || "(none)");
console.log("ranker responses captured:", payloads.length);
await page.close();
await browser.disconnect();
