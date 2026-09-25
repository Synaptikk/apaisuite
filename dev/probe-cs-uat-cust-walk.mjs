// UAT notice 19060: from the prefilled StartPage, Next → photos → Next → dump GL_Customer Statement DOM.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = (await browser.pages()).find(p => /intakenotice\/19060/.test(p.url()));
await page.bringToFront();
const clickNext = async () => page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
const steps = () => page.evaluate(() => [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean))]);
const vals = await page.evaluate(() => ({ t: document.getElementById("STARS_464_id")?.value, f: document.getElementById("STARS_792_id")?.value, cust: document.getElementById("radio-Customer Incident-STARS_454")?.checked, gl: document.getElementById("radio-Customer Injury or Property Damage-STARS_7")?.checked, n11: document.getElementById("STARS_11_INPUT")?.value }));
console.log("prefilled:", JSON.stringify(vals));
console.log("Next1:", await clickNext()); await sleep(8000);
console.log("steps:", JSON.stringify(await steps()));
let txt = await page.evaluate(() => document.body.innerText);
if (/Photo Evidence/.test(txt) && /Attach Photos/.test(txt)) {
  await page.evaluate(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(3000);
  const fi = await page.$(".slds-modal input[type=file]");
  await fi.uploadFile(`${OUT}/TEST_photo_1.png`, `${OUT}/TEST_photo_2.png`, `${OUT}/TEST_photo_3.png`); await sleep(3000);
  await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = [...m.querySelectorAll("button")].find(b => /^upload file$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(8000);
  const done = await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const t = (m?.innerText || "").replace(/\n+/g, " | ").slice(0, 300); const b = m && [...m.querySelectorAll("button")].find(b => /^done$/i.test((b.innerText || "").trim())); b && b.click(); return t; }); await sleep(2000);
  console.log("upload modal:", done);
  console.log("Next2:", await clickNext()); await sleep(9000);
}
console.log("steps:", JSON.stringify(await steps()));
txt = await page.evaluate(() => document.body.innerText);
console.log("PAGE:", txt.replace(/\n+/g, " | ").slice(280, 3500));
writeFileSync(`${OUT}/uat-cust-stmt.txt`, txt); writeFileSync(`${OUT}/uat-cust-stmt.html`, await page.content());
await page.screenshot({ path: `${OUT}/uat-cust-stmt.png`, fullPage: true });
await browser.disconnect();
