// dev/boblisa-storage-probe.mjs — list boblisa.* keys in the debug-Edge extension storage with sizes.
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
const out = await page.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const rows = Object.entries(all).filter(([k]) => k.startsWith("boblisa.")).map(([k, v]) => ({ k, bytes: JSON.stringify(v).length, schema: v?.schema, fetchedAt: v?.fetchedAt, pairs: v?.pairs?.length, err: v?.error, recs: v?.records ? Object.keys(v.records).length : undefined }));
  const total = Object.entries(all).reduce((s, [k, v]) => s + JSON.stringify(v).length, 0);
  const inUse = await new Promise((r) => chrome.storage.local.getBytesInUse(null, r));
  return { rows: rows.sort((a, b) => a.k.localeCompare(b.k)), totalJson: total, inUse, keys: Object.keys(all).length };
});
console.log(JSON.stringify(out, null, 1));
await page.close(); browser.disconnect();
