// UAT only. Click "New Incident" and dump the first intake page. Records XHRs.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes("uat.riskonnectclearsight.com"));
if (!page) { console.log("no UAT tab"); process.exit(1); }
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if (t === "xhr" || t === "fetch") reqs.push({ m: r.method(), u: r.url().slice(0, 240), body: (r.postData() || "").slice(0, 400) }); });
page.on("response", async r => { const u = r.url(); if (/intake|stars|lookup|picklist|metadata|form/i.test(u) && (r.request().resourceType() === "xhr" || r.request().resourceType() === "fetch")) { try { const t = await r.text(); writeFileSync(`${OUT}/resp-${reqs.length}-${u.replace(/[^a-z0-9]+/gi, "_").slice(-80)}.txt`, t); } catch {} } });
console.log("URL:", page.url());
await page.bringToFront();
const btn = await page.evaluateHandle(() => [...document.querySelectorAll("button, a, [role='button']")].find(b => /^new incident$/i.test((b.innerText||"").trim())));
if (!(await btn.asElement())) { console.log("New Incident button not found. BODY:", (await page.evaluate(() => document.body.innerText)).slice(0, 800)); process.exit(1); }
await btn.asElement().click();
let text = "";
for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 2000)); text = await page.evaluate(() => document.body.innerText || ""); if (!/Click on search to initiate/.test(text) && text.length > 300) break; }
console.log("AFTER URL:", page.url());
console.log("BODY:", text.slice(0, 5000));
console.log("XHR:", JSON.stringify(reqs, null, 1));
writeFileSync(`${OUT}/uat-new-incident-1.html`, await page.content());
await browser.disconnect();
