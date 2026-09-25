// UAT notice 19060 (customer path): fill StartPage with verification, Next, photos, Next, dump Customer Statement.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = (await browser.pages()).find(p => /intakenotice\/19060/.test(p.url()));
await page.bringToFront();
await page.waitForSelector("#STARS_464_id", { timeout: 60000 }); await sleep(2000);
const combo = async (id, text, re) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const el = await page.$(`#${id}`); await el.click(); await sleep(300); await el.click({ clickCount: 3 }); await page.keyboard.press("Backspace"); await el.type(text, { delay: 60 }); await sleep(2500);
    const picked = await page.evaluate((src) => { const re = new RegExp(src); const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option, li.slds-listbox__item")].find(x => re.test(x.textContent) && x.getBoundingClientRect().width > 0); if (o) { o.click(); return o.textContent.trim().slice(0, 50); } return null; }, re.source);
    await sleep(800);
    const v = await page.evaluate((id) => document.getElementById(id)?.value, id);
    console.log(`${id} attempt ${attempt}: picked=${picked} value="${v}"`);
    if (v) return v;
  }
};
const date = async (idx, val) => { const dps = await page.$$("input[name='datepicker']"); const el = dps[idx]; await el.click({ clickCount: 3 }); await el.type(val, { delay: 40 }); await page.keyboard.press("Tab"); await sleep(600); return page.evaluate((i) => document.querySelectorAll("input[name='datepicker']")[i]?.value, idx); };
console.log("date1:", await date(0, "9/16/2026"));
await combo("STARS_464_id", "11:30 AM", /11:30 AM/);
await combo("STARS_792_id", "1458", /1458/);
console.log("date2:", await date(1, "9/16/2026"));
await page.evaluate(() => document.getElementById("radio-Customer Incident-STARS_454")?.click()); await sleep(2500);
await page.evaluate(() => document.getElementById("radio-Customer Injury or Property Damage-STARS_7")?.click()); await sleep(2500);
let vis = await page.evaluate(() => [...document.querySelectorAll("input[type=radio]")].filter(r => r.getBoundingClientRect().width > 0).map(r => r.id + (r.checked ? "[x]" : "")));
console.log("visible radios:", JSON.stringify(vis));
await page.evaluate(() => document.getElementById("radio-No-STARS_312")?.click()); await sleep(1500);
await page.evaluate(() => document.getElementById("radio-No-STARS_10")?.click()); await sleep(1500);
const c = await page.$("#STARS_11_INPUT"); await c.click({ clickCount: 3 }); await c.type("555-555-0100", { delay: 30 }); await page.keyboard.press("Tab"); await sleep(800);
vis = await page.evaluate(() => [...document.querySelectorAll("input[type=radio]")].filter(r => r.getBoundingClientRect().width > 0).map(r => r.id + (r.checked ? "[x]" : "")));
console.log("visible radios now:", JSON.stringify(vis));
const buttons = await page.evaluate(() => [...document.querySelectorAll("button, a")].filter(b => b.getBoundingClientRect().width > 0).map(b => (b.innerText || "").trim()).filter(t => /next|back/i.test(t)));
console.log("nav buttons:", JSON.stringify(buttons));
await page.screenshot({ path: `${OUT}/uat-cust-start2.png`, fullPage: true });
const clickNext = async () => page.evaluate(() => { const b = [...document.querySelectorAll("button, a")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
console.log("Next:", await clickNext()); await sleep(8000);
let txt = await page.evaluate(() => document.body.innerText); console.log("PAGE2:", txt.replace(/\n+/g, " | ").slice(280, 520));
if (/Photo Evidence/.test(txt)) {
  await page.evaluate(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(3000);
  const fi = await page.$(".slds-modal input[type=file]");
  await fi.uploadFile(`${OUT}/TEST_photo_1.png`, `${OUT}/TEST_photo_2.png`, `${OUT}/TEST_photo_3.png`); await sleep(3000);
  await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = [...m.querySelectorAll("button")].find(b => /^upload file$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(8000);
  await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = m && [...m.querySelectorAll("button")].find(b => /^done$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(2000);
  console.log("photos uploaded");
  console.log("Next:", await clickNext()); await sleep(9000);
}
txt = await page.evaluate(() => document.body.innerText);
console.log("PAGE3:", txt.replace(/\n+/g, " | ").slice(280, 3200));
writeFileSync(`${OUT}/uat-cust-stmt.txt`, txt); writeFileSync(`${OUT}/uat-cust-stmt.html`, await page.content());
await page.screenshot({ path: `${OUT}/uat-cust-stmt.png`, fullPage: true });
await browser.disconnect();
