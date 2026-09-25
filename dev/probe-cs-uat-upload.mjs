// UAT: upload three tiny TEST PNGs through the open attachment modal; record the upload API.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
await page.bringToFront();
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && !/nr-data|CheckForceLogOut/.test(r.url())) { const h = r.headers(); reqs.push({ m: r.method(), u: r.url().slice(0, 300), ct: h["content-type"], body: (r.postData() || "").slice(0, 1200) }); } });
page.on("response", async r => { const i = reqs.findIndex(x => x.u === r.url().slice(0, 300) && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 1500); } catch {} } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const modalOpen = await page.$(".slds-modal.slds-fade-in-open");
if (!modalOpen) { await page.evaluate(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(3000); }
const fileInput = await page.$(".slds-modal input[type=file]");
if (!fileInput) { console.log("no file input"); process.exit(1); }
await fileInput.uploadFile(`${OUT}/TEST_photo_1.png`, `${OUT}/TEST_photo_2.png`, `${OUT}/TEST_photo_3.png`);
await sleep(4000);
let modal = await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); return { text: (m?.innerText || "").slice(0, 2000), buttons: [...(m?.querySelectorAll("button") || [])].map(b => ({ id: b.id, t: (b.innerText || b.title || "").trim(), dis: b.disabled })).filter(b => b.t || b.id) }; });
console.log("MODAL AFTER SELECT:", JSON.stringify(modal, null, 1));
await page.screenshot({ path: `${OUT}/uat-upload-1.png` });
// click an Upload/Save/Attach button if present
const clickedUpload = await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = [...(m?.querySelectorAll("button") || [])].find(b => /^(upload|save|attach|ok|done|submit)/i.test((b.innerText || b.title || "").trim()) && !b.disabled); if (b) { b.click(); return (b.innerText || b.title).trim(); } return null; });
console.log("clicked:", clickedUpload);
await sleep(8000);
modal = await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); return { open: !!m, text: (m?.innerText || "").slice(0, 2000), buttons: [...(m?.querySelectorAll("button") || [])].map(b => ({ id: b.id, t: (b.innerText || b.title || "").trim(), dis: b.disabled })).filter(b => b.t || b.id) }; });
console.log("MODAL AFTER UPLOAD:", JSON.stringify(modal, null, 1));
await page.screenshot({ path: `${OUT}/uat-upload-2.png` });
console.log("PAGE TEXT:", (await page.evaluate(() => document.body.innerText)).slice(0, 1500));
writeFileSync(`${OUT}/upload-xhr.json`, JSON.stringify(reqs, null, 1));
console.log("XHR:", JSON.stringify(reqs.map(r => ({ ...r, u: r.u.replace("https://uat.riskonnectclearsight.com/Enterprise/", "") })), null, 1));
await browser.disconnect();
