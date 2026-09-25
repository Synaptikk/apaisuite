// dev/costinv-e2e.mjs — reload the suite in the debug Edge, open the
// costinventory module and run a real pull.
import puppeteer from "puppeteer-core";

const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const APP = `chrome-extension://${EXT_ID}/app.html`;
const STORE = process.argv[2] || "1458";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 240_000 });

// Open a fresh app.html BEFORE reloading — chrome.runtime.reload() detaches
// the page handle it was called from (memory: edge-debug-cdp-browser-route).
let page = await browser.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 2500));
await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
await new Promise(r => setTimeout(r, 4000));
try { await page.close(); } catch {}

page = await browser.newPage();
await page.goto(APP + "#/costinventory", { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));

const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

const mounted = await page.evaluate(() => {
  const root = document.querySelector(".module-costinventory, .ci");
  return { found: !!root, heading: document.querySelector(".ci-title h1")?.textContent ?? null,
           rows: document.querySelectorAll(".ci-row").length,
           controls: [...document.querySelectorAll(".ci-field span")].map(s => s.childNodes[0]?.textContent?.trim()) };
});
console.log("MOUNT:", JSON.stringify(mounted));
if (!mounted.found) { console.log("errors:", errors.slice(0,5)); await browser.disconnect(); process.exit(1); }

// Fill the store, type a count for one department, then pull.
await page.evaluate((store) => {
  const s = document.querySelector("[data-store]");
  s.value = store;
  s.dispatchEvent(new Event("change", { bubbles: true }));
}, STORE);

const dates = await page.evaluate(() => ({
  windowStart: document.querySelector("[data-window-start]").value,
  windowEnd:   document.querySelector("[data-window-end]").value,
  night:       document.querySelector("[data-night]").value,
}));
console.log("DATES:", JSON.stringify(dates));

console.log("pulling…");
await page.click('[data-action="pull"]');
await page.waitForFunction(() => !document.querySelector('[data-action="pull"]').disabled, { timeout: 200000 });
await new Promise(r => setTimeout(r, 1500));

const result = await page.evaluate(() => {
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  return {
    freshness: txt(document.querySelector("[data-freshness]")),
    sources: [...document.querySelectorAll(".ci-source")].map(txt),
    grid: [...document.querySelectorAll(".ci-row")].map(r => txt(r).slice(0, 150)),
    trailers: txt(document.querySelector("[data-trailer-body]")).slice(0, 900),
    exportEnabled: !document.querySelector('[data-action="export"]').disabled,
  };
});
console.log("\nFRESHNESS:", result.freshness);
console.log("SOURCES:");   for (const s of result.sources) console.log("   " + s);
console.log("GRID:");      for (const g of result.grid) console.log("   " + g);
console.log("\nTRAILERS:", result.trailers);
console.log("\nexport enabled:", result.exportEnabled);
if (errors.length) console.log("\nPAGE ERRORS:\n" + errors.slice(0, 8).join("\n"));
await browser.disconnect();
