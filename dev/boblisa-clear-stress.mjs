// dev/boblisa-clear-stress.mjs — open BoB and Lisa in the debug Edge, go to the unmanned tab and click
// Clear on N rows one after another while sampling JS heap + DOM node count, to see whether the
// review-queue repaint grows without bound (renderer STATUS_BREAKPOINT seen 2026-09-17). Then Undo them all.
// Usage: node dev/boblisa-clear-stress.mjs [n]
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const N = Number(process.argv[2] || 8);
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 240000 });
const page = await browser.newPage();
const crashes = [];
page.on("error", (e) => crashes.push(String(e)));
await page.goto(`chrome-extension://${EXT}/app.html#/boblisa`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 6000));
const cdp = await page.createCDPSession();
await cdp.send("Performance.enable");
const sample = async (label) => {
  const m = await cdp.send("Performance.getMetrics");
  const g = (n) => m.metrics.find((x) => x.name === n)?.value;
  const rows = await page.evaluate(() => ({ rows: document.querySelectorAll("[data-table='unmanned'] tr.bl-row").length, mannedRows: document.querySelectorAll("[data-table='manned'] tr.bl-row").length, html: document.body.innerHTML.length }));
  console.log(`${label.padEnd(12)} heap ${(g("JSHeapUsedSize") / 1048576).toFixed(1)} MB  nodes ${g("Nodes")}  listeners ${g("JSEventListeners")}  unmanned rows ${rows.rows}  manned rows ${rows.mannedRows}  html ${(rows.html / 1048576).toFixed(1)} MB`);
};
await page.evaluate(() => document.querySelector(".bl-tab[data-tab='unmanned']")?.click());
await new Promise((r) => setTimeout(r, 800));
await sample("start");
const cleared = [];
for (let i = 0; i < N; i++) {
  const key = await page.evaluate(() => { const b = document.querySelector("[data-table='unmanned'] .bl-clear"); if (!b) return null; const k = b.dataset.key; b.click(); return k; });
  if (!key) { console.log("no more Clear buttons"); break; }
  cleared.push(key);
  await new Promise((r) => setTimeout(r, 1500));
  await sample(`clear ${i + 1}`);
  if (crashes.length) break;
}
console.log("crashes:", crashes);
// put them back
for (const key of cleared) { await page.evaluate((k) => new Promise((res) => chrome.runtime.sendMessage({ module: "boblisa", type: "set_review", key: k, cleared: false }, res)), key); }
await new Promise((r) => setTimeout(r, 1500));
await sample("after undo");
await page.close(); browser.disconnect();
