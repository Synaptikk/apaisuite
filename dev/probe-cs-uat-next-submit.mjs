// UAT notice: click Next through the prefilled pages until Submit appears, then Submit + OK, capture everything.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = (process.argv.find(a => a.startsWith("--notice=")) || "--notice=19060").slice(9);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => new RegExp("intakenotice/" + NOTICE).test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
page.on("dialog", async d => { console.log("DIALOG:", d.message().slice(0, 200)); await d.accept(); });
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut|InterviewLookup/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 160), body: r.postData() || "" }); });
page.on("response", async r => { const key = r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 160); const i = reqs.findIndex(x => x.u === key && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 3000); } catch {} } });
const steps = () => page.evaluate(() => [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean))]);
for (let i = 0; i < 8; i++) {
  const hasSubmit = await page.evaluate(() => !![...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0));
  if (hasSubmit) { console.log("Submit visible at", JSON.stringify(await steps())); break; }
  const c = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log(`Next ${i}:`, c, JSON.stringify(await steps()).slice(0, 200)); if (!c) break; await sleep(8000);
}
reqs.length = 0;
const sub = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
console.log("Submit:", sub); await sleep(4000);
console.log("confirm:", await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); if (!m) return null; const b = [...m.querySelectorAll("button")].find(b => /^ok$/i.test((b.innerText || "").trim())); b && b.click(); return (m.innerText || "").replace(/\n+/g, " | ").slice(0, 200); }));
await sleep(15000);
const txt = await page.evaluate(() => document.body.innerText);
console.log("URL:", page.url());
console.log("RESULT:", txt.replace(/\n+/g, " | ").slice(0, 3000));
await page.screenshot({ path: `${OUT}/submit4-${NOTICE}-result.png`, fullPage: true });
writeFileSync(`${OUT}/submit4-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
for (const r of reqs) { let meta = ""; try { const b = JSON.parse(r.body); meta = JSON.stringify({ Command: b.Command, PageId: b.PageId, NoticeStatus: b.NoticeStatus, IsClosing: b.IsClosing, EntityNumber: b.EntityNumber }); } catch {} console.log(r.m, r.u.slice(0, 110), r.status, meta, "RESP:", (r.resp || "").slice(0, 250).replace(/\s+/g, " ")); }
await browser.disconnect();
