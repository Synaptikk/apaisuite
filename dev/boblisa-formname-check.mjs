// dev/boblisa-formname-check.mjs — forget one operator's name in the debug profile, open the
// miss form for a pair they rang, and confirm the form looks the name up on its own.
// Usage: node dev/boblisa-formname-check.mjs [appriss|banner]  — which kind of operator to forget:
// one APPRISS already named (default) or one only the journal banner names (exercises the EJ fallback).
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const mode = process.argv[2] === "banner" ? "banner" : "appriss";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 300000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await sleep(4000);
page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html#/boblisa`, { waitUntil: "domcontentloaded" });
await page.bringToFront();
await sleep(4000);
// Pick a manned pair whose op APPRISS already named, then forget that name.
const pick = await page.evaluate(async (mode) => {
  const doc = (await chrome.storage.local.get("boblisa.operators.1458"))["boblisa.operators.1458"];
  const row = [...document.querySelectorAll('.bl-row')].map((r) => ({ key: r.dataset.key, op: r.textContent.match(/op (\d+)/)?.[1] })).find((x) => mode === "banner" ? (!doc.people[x.op] && doc.names[x.op]) : doc.people[x.op]);
  if (!row) return null;
  const was = { name: doc.names[row.op], person: doc.people[row.op] };
  delete doc.names[row.op]; delete doc.people[row.op];
  await chrome.storage.local.set({ "boblisa.operators.1458": doc });
  return { ...row, was };
}, mode);
log({ pick });
if (!pick) { browser.disconnect(); process.exit(1); }
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(4000);
const rowBefore = await page.evaluate((k) => document.querySelector(`.bl-row[data-key="${k}"] td:nth-child(2)`)?.textContent.replace(/\s+/g, " ").trim(), pick.key);
await page.evaluate((k) => document.querySelector(`.bl-row[data-key="${k}"]`).click(), pick.key);
await sleep(300);
await page.evaluate(() => document.querySelector(".bl-doc-open").click());
await sleep(300);
const form = () => page.evaluate(() => { const f = document.querySelector("[data-docform]"); return { name: f.cashierName.value, hint: f.querySelector(".bl-namehint")?.textContent, note: f.note.value }; });
const t0 = await form();
let t1;
for (let i = 0; i < 80; i++) { await sleep(1500); t1 = await form(); if (t1.name || /not in APPRISS|signed out/.test(t1.hint)) break; }
const stored = await page.evaluate((op) => chrome.storage.local.get("boblisa.operators.1458").then((r) => ({ person: r["boblisa.operators.1458"]?.people?.[op]?.name, banner: r["boblisa.operators.1458"]?.names?.[op] })), pick.op);
await page.evaluate(() => document.querySelector(".bl-doc-cancel").click());
log({ rowBefore, opening: t0, after: { ...t1, title: await page.evaluate(() => document.querySelector("[data-docform] [name=cashierName]")?.title) }, stored });
browser.disconnect();
