// UAT TEST EVENT: fill StartPage with obviously-test values, click Next, record every XHR (with bodies).
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
await page.bringToFront();
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && !/CheckForceLogOut/.test(r.url())) reqs.push({ m: r.method(), u: r.url(), body: r.postData() || "" }); });
page.on("response", async r => { const i = reqs.findIndex(x => x.u === r.url() && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 3000); } catch {} } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const typeInto = async (sel, text) => { const el = await page.$(sel); if (!el) { console.log("MISSING", sel); return false; } await el.click({ clickCount: 3 }); await el.type(text, { delay: 30 }); return true; };
// 1. date/time of incident (first datepicker)
const dps = await page.$$("input[name='datepicker']");
console.log("datepickers:", dps.length);
if (dps[0]) { await dps[0].click({ clickCount: 3 }); await dps[0].type("9/16/2026", { delay: 30 }); await page.keyboard.press("Tab"); await sleep(500); }
// 2. time of incident combobox STARS_464
await typeInto("#STARS_464_id", "10:00 AM"); await sleep(1500);
let picked = await page.evaluate(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option, li[role='presentation'] *")].find(x => /10:00 AM/.test(x.textContent)); if (o) { o.click(); return o.textContent.trim(); } return null; });
console.log("time picked:", picked);
if (!picked) { await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); }
await sleep(500);
// 3. facility STARS_792
await typeInto("#STARS_792_id", "1458"); await sleep(1500);
picked = await page.evaluate(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option")].find(x => /1458/.test(x.textContent)); if (o) { o.click(); return o.textContent.trim(); } return null; });
console.log("facility picked:", picked);
if (!picked) { await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); }
await sleep(800);
// 4. notified date (second datepicker)
const dps2 = await page.$$("input[name='datepicker']");
if (dps2[1]) { await dps2[1].click({ clickCount: 3 }); await dps2[1].type("9/16/2026", { delay: 30 }); await page.keyboard.press("Tab"); await sleep(500); }
// 5. type = Associate
await page.click("#radio-Associate\ Incident-STARS_454").catch(async () => { await page.evaluate(() => document.getElementById("radio-Associate Incident-STARS_454")?.click()); });
await sleep(1500);
// 6. facility services? No
await page.evaluate(() => document.getElementById("radio-No-STARS_322")?.click()); await sleep(500);
// 7. contact number
await typeInto("#STARS_11_INPUT", "555-555-0100"); await page.keyboard.press("Tab"); await sleep(500);
// state before Next
const before = await page.evaluate(() => ({ url: location.href, vals: { d1: document.querySelectorAll("input[name='datepicker']")[0]?.value, t: document.getElementById("STARS_464_id")?.value, fac: document.getElementById("STARS_792_id")?.value, d2: document.querySelectorAll("input[name='datepicker']")[1]?.value, n26: document.getElementById("STARS_26_INPUT")?.value, n11: document.getElementById("STARS_11_INPUT")?.value, assoc: document.getElementById("radio-Associate Incident-STARS_454")?.checked, fs: document.getElementById("radio-No-STARS_322")?.checked }, visibleText: document.body.innerText.slice(0, 2500) }));
console.log("BEFORE NEXT:", JSON.stringify(before.vals));
await page.screenshot({ path: `${OUT}/uat-step1-before.png`, fullPage: true });
// 8. click the visible Next
const nexts = await page.$$("button, a");
let clicked = false;
for (const b of nexts) { const t = (await (await b.getProperty("innerText")).jsonValue() || "").trim(); const box = await b.boundingBox(); if (t === "Next" && box) { await b.click(); clicked = true; break; } }
console.log("clicked Next:", clicked);
for (let i = 0; i < 10; i++) { await sleep(2000); const u = page.url(); if (!u.includes("isNew=true") || i === 9) break; }
await sleep(3000);
console.log("AFTER URL:", page.url());
await page.screenshot({ path: `${OUT}/uat-step1-after.png`, fullPage: true });
const after = await page.evaluate(() => document.body.innerText);
console.log("AFTER BODY:", after.slice(0, 3000));
writeFileSync(`${OUT}/step1-xhr.json`, JSON.stringify(reqs, null, 1));
console.log("XHR:", JSON.stringify(reqs.map(r => ({ m: r.m, u: r.u.replace("https://uat.riskonnectclearsight.com/Enterprise/", ""), status: r.status, body: r.body.slice(0, 600), resp: (r.resp || "").slice(0, 300) })), null, 1));
await browser.disconnect();
