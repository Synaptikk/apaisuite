// dev/boblisa-doc-check.mjs — reload the debug-Edge extension, open BoB and Lisa,
// document the first manned pair, look up APPRISS video for it, screenshot the
// expanded row and the Documented tab, then remove the test record.
// Usage: node dev/boblisa-doc-check.mjs <outdir>   (mirror modules/boblisa into APAISuite-dev first)
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 300000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await sleep(4000);
page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("dialog", (d) => d.accept());
await page.goto(`chrome-extension://${EXT}/app.html#/boblisa`, { waitUntil: "domcontentloaded" });

// Wait for pairs (a schema bump makes the module re-pull every day first).
let rows = 0;
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  rows = await page.evaluate(() => document.querySelectorAll('[data-table="manned"] .bl-row').length);
  const prog = await page.evaluate(() => document.querySelector("#boblisa-progress")?.textContent || "");
  if (rows && !prog) break;
  if (i % 6 === 5) console.log("waiting…", { rows, prog });
}
const summary = await page.evaluate(() => [...document.querySelectorAll(".bl-sum")].map((e) => e.textContent.replace(/\s+/g, " ").trim()));
console.log(JSON.stringify({ rows, summary }));
if (!rows) { console.log(JSON.stringify({ errors })); browser.disconnect(); process.exit(1); }

// Expand the first manned row and open the form.
const key = await page.evaluate(() => { const r = document.querySelector('[data-table="manned"] .bl-row'); r.click(); return r.dataset.key; });
await sleep(500);
const before = await page.evaluate(() => ({ doc: !!document.querySelector(".bl-doc"), openBtn: !!document.querySelector(".bl-doc-open"), vidBtn: !!document.querySelector(".bl-vid-find") }));
await page.click(".bl-doc-open");
await sleep(300);
const form = await page.evaluate(() => {
  const f = document.querySelector("[data-docform]");
  return f ? { cause: f.cause.value, outcome: f.outcome.value, video: f.video.value, note: f.note.value } : null;
});
console.log(JSON.stringify({ key, before, form }));

// Video lookup through Open Drawer (needs the APPRISS session in this profile).
await page.click(".bl-vid-find");
let vid = "";
for (let i = 0; i < 24; i++) { await sleep(2500); vid = await page.evaluate(() => document.querySelector(".bl-vidrow")?.textContent.replace(/\s+/g, " ").trim() || ""); if (!/Looking up/.test(vid)) break; }
const vidLinks = await page.evaluate(() => [...document.querySelectorAll(".bl-vidrow a")].map((a) => a.textContent.trim() + " → " + a.href.slice(0, 90)));
console.log(JSON.stringify({ vid, vidLinks }));

// Fill and save.
await page.evaluate(() => { const f = document.querySelector("[data-docform]"); f.video.value = "confirmed"; f.cashierName.value = "Test Cashier"; f.note.value += " [dev check]"; });
await page.screenshot({ path: `${out}/boblisa-form.png` });
await page.click("[data-docform] [type=submit]");
await sleep(1500);
const after = await page.evaluate(() => ({
  count: document.querySelector("#boblisa-cnt-documented")?.textContent,
  badge: !!document.querySelector('[data-table="manned"] .bl-docd'),
  card: document.querySelector(".bl-doc-card")?.textContent.replace(/\s+/g, " ").trim().slice(0, 240),
}));
console.log(JSON.stringify({ after }));

// Documented tab.
await page.click('.bl-tab[data-tab="documented"]');
await sleep(400);
const docTab = await page.evaluate(() => ({
  rollup: [...document.querySelectorAll(".bl-cashier")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
  rows: document.querySelectorAll(".bl-docrow").length,
  firstRow: document.querySelector(".bl-docrow")?.textContent.replace(/\s+/g, " ").trim().slice(0, 300),
}));
console.log(JSON.stringify({ docTab }));
await page.screenshot({ path: `${out}/boblisa-documented.png` });

// Edit from the Documented tab, then remove the test record.
await page.click(".bl-docrow .bl-doc-open");
await sleep(300);
const editForm = await page.evaluate(() => { const f = document.querySelector('[data-table="documented"] [data-docform]'); return f ? { cashierName: f.cashierName.value, video: f.video.value } : null; });
await page.evaluate(() => { const f = document.querySelector('[data-table="documented"] [data-docform]'); f.cause.value = "inside_item"; });
await page.click('[data-table="documented"] [data-docform] [type=submit]');
await sleep(1200);
const edited = await page.evaluate(() => document.querySelector(".bl-docrow td:nth-child(6)")?.textContent.replace(/\s+/g, " ").trim());
await page.click(".bl-docrow .bl-doc-remove");
await sleep(1200);
const removed = await page.evaluate(() => ({ count: document.querySelector("#boblisa-cnt-documented")?.textContent, rows: document.querySelectorAll(".bl-docrow").length }));
console.log(JSON.stringify({ editForm, edited, removed, errors: errors.slice(0, 8) }));
browser.disconnect();
