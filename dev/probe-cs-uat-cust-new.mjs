// UAT TEST EVENT #2 (customer path): New Incident → StartPage (CUST/GL) → photos → Customer Statement page dump.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice$/.test(p.url()) || /intakenotice\?/.test(p.url()) && !/intakenotice\/\d+/.test(p.url()));
if (!list) { list = await browser.newPage(); await list.goto("https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/#/intake/stars.intakenotice", { waitUntil: "domcontentloaded" }); await sleep(8000); }
await list.bringToFront();
const before = new Set((await browser.pages()).map(p => p.url()));
const ok = await list.evaluate(() => { const b = [...document.querySelectorAll("button, a")].find(b => /^new incident$/i.test((b.innerText || "").trim())); if (b) { b.click(); return true; } return false; });
console.log("New Incident clicked:", ok);
let page = null;
for (let i = 0; i < 15 && !page; i++) { await sleep(2000); page = (await browser.pages()).find(p => /intakenotice\/\d+/.test(p.url()) && !before.has(p.url())); }
if (!page) { console.log("no new notice tab"); process.exit(1); }
console.log("NEW NOTICE:", page.url());
await page.bringToFront(); await sleep(6000);
const typeInto = async (sel, text) => { const el = await page.$(sel); if (!el) { console.log("MISSING", sel); return false; } await el.click({ clickCount: 3 }); await el.type(text, { delay: 25 }); return true; };
const pickOption = async (re) => page.evaluate((src) => { const re = new RegExp(src); const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option")].find(x => re.test(x.textContent)); if (o) { o.click(); return o.textContent.trim(); } return null; }, re.source);
let dps = await page.$$("input[name='datepicker']");
await dps[0].click({ clickCount: 3 }); await dps[0].type("9/16/2026", { delay: 25 }); await page.keyboard.press("Tab"); await sleep(500);
await typeInto("#STARS_464_id", "11:30 AM"); await sleep(1500); console.log("time:", await pickOption(/11:30 AM/)); await sleep(500);
await typeInto("#STARS_792_id", "1458"); await sleep(1500); console.log("facility:", await pickOption(/1458/)); await sleep(800);
dps = await page.$$("input[name='datepicker']"); await dps[1].click({ clickCount: 3 }); await dps[1].type("9/16/2026", { delay: 25 }); await page.keyboard.press("Tab"); await sleep(500);
await page.evaluate(() => document.getElementById("radio-Customer Incident-STARS_454")?.click()); await sleep(2000);
await page.evaluate(() => document.getElementById("radio-Customer Injury or Property Damage-STARS_7")?.click()); await sleep(1500);
await page.evaluate(() => document.getElementById("radio-No-STARS_312")?.click()); await sleep(800);
await page.evaluate(() => document.getElementById("radio-No-STARS_10")?.click()); await sleep(800);
await typeInto("#STARS_11_INPUT", "555-555-0100"); await page.keyboard.press("Tab"); await sleep(500);
const st = await page.evaluate(() => ({ cust: document.getElementById("radio-Customer Incident-STARS_454")?.checked, gl: document.getElementById("radio-Customer Injury or Property Damage-STARS_7")?.checked, tp: document.getElementById("radio-No-STARS_312")?.checked, res: document.getElementById("radio-No-STARS_10")?.checked, t: document.getElementById("STARS_464_id")?.value, f: document.getElementById("STARS_792_id")?.value, visibleRadios: [...document.querySelectorAll("input[type=radio]")].filter(r => r.getBoundingClientRect().width > 0).map(r => r.id) }));
console.log("STATE:", JSON.stringify(st));
await page.screenshot({ path: `${OUT}/uat-cust-start.png`, fullPage: true });
const clickNext = async () => { const bs = await page.$$("button, a"); for (const b of bs) { const t = ((await (await b.getProperty("innerText")).jsonValue()) || "").trim(); if (t === "Next" && await b.boundingBox()) { await b.click(); return true; } } return false; };
console.log("Next:", await clickNext()); await sleep(7000);
let txt = await page.evaluate(() => document.body.innerText); console.log("PAGE2:", txt.replace(/\n+/g, " | ").slice(300, 700));
// photos
await page.evaluate(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(3000);
const fi = await page.$(".slds-modal input[type=file]");
if (fi) { await fi.uploadFile(`${OUT}/TEST_photo_1.png`, `${OUT}/TEST_photo_2.png`, `${OUT}/TEST_photo_3.png`); await sleep(3000);
  await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = [...m.querySelectorAll("button")].find(b => /^upload file$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(8000);
  await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = m && [...m.querySelectorAll("button")].find(b => /^done$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(2000);
  console.log("photos uploaded");
}
console.log("Next:", await clickNext()); await sleep(8000);
txt = await page.evaluate(() => document.body.innerText);
console.log("URL:", page.url());
console.log("PAGE3:", txt.replace(/\n+/g, " | ").slice(300, 3000));
writeFileSync(`${OUT}/uat-cust-stmt.txt`, txt); writeFileSync(`${OUT}/uat-cust-stmt.html`, await page.content());
await page.screenshot({ path: `${OUT}/uat-cust-stmt.png`, fullPage: true });
await browser.disconnect();
