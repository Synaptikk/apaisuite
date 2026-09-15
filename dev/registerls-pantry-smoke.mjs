// dev/registerls-pantry-smoke.mjs — reload the debug-Edge extension, open Register L/S Triage,
// exercise the Pantry list card (add a throwaway UPC through the form, confirm it renders,
// remove it again) and screenshot the card. Usage: node dev/registerls-pantry-smoke.mjs <out.png>
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || "registerls-pantry.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 240000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await sleep(4000);
page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`chrome-extension://${EXT}/app.html#/registerls`, { waitUntil: "domcontentloaded" });
await sleep(8000);
const before = await page.evaluate(() => {
  const box = document.querySelector("[data-pantrylist]");
  if (!box) return null;
  box.open = true;
  return { hidden: box.hidden, meta: box.querySelector("[data-pantrylist-meta]")?.textContent, rows: box.querySelectorAll(".rls-pantry-table tbody tr").length };
});
// Add a throwaway item through the form, then remove it.
await page.evaluate(() => { document.querySelector("#rls-pantry-text").value = "0009990001 SMOKE TEST COFFEE\nnot a upc"; document.querySelector("[data-pantry-form]").requestSubmit(); });
await sleep(2500);
const added = await page.evaluate(() => {
  const box = document.querySelector("[data-pantrylist]");
  const row = [...box.querySelectorAll(".rls-pantry-table tbody tr")].find((r) => r.textContent.includes("SMOKE TEST COFFEE"));
  return { meta: box.querySelector("[data-pantrylist-meta]")?.textContent, found: !!row, source: row?.children[2]?.textContent, hasRemove: !!row?.querySelector("[data-action='pantry-remove']"), textareaCleared: document.querySelector("#rls-pantry-text").value === "" };
});
await page.setViewport({ width: 1400, height: 1000 });
await page.evaluate(() => document.querySelector("[data-pantrylist]").scrollIntoView());
await page.screenshot({ path: out, fullPage: false });
await page.evaluate(() => { [...document.querySelectorAll("[data-action='pantry-remove']")].find((b) => b.closest("tr").textContent.includes("SMOKE TEST COFFEE"))?.click(); });
await sleep(2500);
const after = await page.evaluate(() => {
  const box = document.querySelector("[data-pantrylist]");
  return { meta: box.querySelector("[data-pantrylist-meta]")?.textContent, rows: box.querySelectorAll(".rls-pantry-table tbody tr").length, stillThere: box.textContent.includes("SMOKE TEST COFFEE") };
});
console.log(JSON.stringify({ before, added, after, errors: errors.slice(0, 5) }, null, 1));
browser.disconnect();
