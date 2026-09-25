// UAT: open the Claims Admin app from the launcher, find incident 26005842, open its folder, list its pages, dump the Evidence Collection page.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const CLAIM = "26005842";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let page = (await browser.pages()).find(x => /intakenotice\/19060/.test(x.url()));
await page.bringToFront();
const reqs = [];
const hook = (pg) => { pg.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut|nr-data/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 220), body: (r.postData() || "").slice(0, 400) }); }); };
hook(page);
const txt = () => page.evaluate(() => document.body.innerText);
const vis = () => page.evaluate(() => { const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const t = el => (el.innerText || el.title || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(); return { buttons: [...new Set([...document.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem]")].filter(v).map(t).filter(x => x && x.length < 60))], inputs: [...document.querySelectorAll("input, select, textarea")].filter(v).map(e => ({ id: e.id, name: e.name, ph: e.placeholder, type: e.type })) }; });
// open launcher if not open, click Claims Admin
let launcher = await page.evaluate(() => !![...document.querySelectorAll("button, a")].find(x => /claims admin/i.test(x.innerText || "") && x.getBoundingClientRect().width > 0));
if (!launcher) { await page.evaluate(() => { const c = [...document.querySelectorAll("button")].find(x => /^open$/i.test((x.innerText || x.title || x.getAttribute("aria-label") || "").trim()) && x.getBoundingClientRect().width > 0); c && c.click(); }); await sleep(3000); }
const before = new Set((await browser.pages()).map(x => x.url()));
await page.evaluate(() => { const c = [...document.querySelectorAll("button, a, [role=menuitem], li")].find(x => /claims admin/i.test(x.innerText || "") && x.getBoundingClientRect().width > 0); c && c.click(); });
await sleep(10000);
const np = (await browser.pages()).find(x => !before.has(x.url()));
if (np) { page = np; hook(page); await page.bringToFront(); await sleep(3000); }
console.log("CLAIMS ADMIN URL:", page.url());
let v = await vis(); console.log("BUTTONS:", JSON.stringify(v.buttons.slice(0, 60))); console.log("INPUTS:", JSON.stringify(v.inputs.slice(0, 20)));
console.log("TEXT:", (await txt()).replace(/\n+/g, " | ").slice(0, 1500));
await page.screenshot({ path: `${OUT}/claimsadmin-1.png`, fullPage: true });
// quick search for the claim number
const qs = await page.$("#quick-search-input-text, input[placeholder*='Search' i]");
if (qs) { await qs.click({ clickCount: 3 }); await qs.type(CLAIM, { delay: 30 }); await page.keyboard.press("Enter"); await sleep(10000); }
console.log("AFTER SEARCH URL:", page.url());
console.log("TEXT:", (await txt()).replace(/\n+/g, " | ").slice(0, 2500));
await page.screenshot({ path: `${OUT}/claimsadmin-2.png`, fullPage: true });
// open the first result row (Open Folder icon / link containing the claim number)
const opened = await page.evaluate((CLAIM) => { const cands = [...document.querySelectorAll("a, button, td, [role=row] *")].filter(x => x.getBoundingClientRect().width > 0); const byNum = cands.find(x => (x.innerText || "").trim() === CLAIM); if (byNum) { byNum.click(); return "clicked claim number"; } const folder = cands.find(x => /open folder|open$/i.test((x.title || x.getAttribute("aria-label") || x.innerText || "").trim())); if (folder) { folder.click(); return "clicked open folder"; } return null; }, CLAIM);
console.log("open result:", opened); await sleep(10000);
const np2 = (await browser.pages()).find(x => !before.has(x.url()) && x !== page);
if (np2) { page = np2; hook(page); await page.bringToFront(); await sleep(3000); }
console.log("FOLDER URL:", page.url());
v = await vis(); console.log("FOLDER MENU/BUTTONS:", JSON.stringify(v.buttons.slice(0, 80)));
console.log("TEXT:", (await txt()).replace(/\n+/g, " | ").slice(0, 2500));
await page.screenshot({ path: `${OUT}/claimsadmin-3.png`, fullPage: true });
// navigate to Incident Info/Evidence Collection if present
const ev = await page.evaluate(() => { const c = [...document.querySelectorAll("a, li, button, span")].find(x => /evidence collection/i.test(x.innerText || "") && x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().width < 500); if (c) { c.click(); return (c.innerText || "").trim(); } return null; });
console.log("evidence page click:", ev); await sleep(10000);
console.log("EVIDENCE URL:", page.url());
const dump = await page.evaluate(() => { const t = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim(); const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rows = []; document.querySelectorAll("input:not([type=hidden]), select, textarea").forEach(el => { if (!v(el)) return; let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = t(l); } if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && v(l)) label = t(l); } } rows.push({ id: el.id, name: el.name, type: el.type || el.tagName, label: label.slice(0, 100), val: (el.value || "").slice(0, 40) }); }); return { rows, text: document.body.innerText }; });
console.log("EVIDENCE CONTROLS:", dump.rows.length); for (const r of dump.rows) console.log(`  ${(r.id || r.name || "").padEnd(36)} ${String(r.type).padEnd(10)} ${r.label}${r.val ? " = " + r.val : ""}`);
console.log("EVIDENCE TEXT:", dump.text.replace(/\n+/g, " | ").slice(0, 3000));
writeFileSync(`${OUT}/evidence-page.html`, await page.content()); writeFileSync(`${OUT}/evidence-page.txt`, dump.text);
await page.screenshot({ path: `${OUT}/claimsadmin-4.png`, fullPage: true });
writeFileSync(`${OUT}/claimsadmin-xhr.json`, JSON.stringify(reqs, null, 1));
console.log("XHR (unique paths):", JSON.stringify([...new Set(reqs.map(r => r.m + " " + r.u.split("?")[0]))], null, 1));
await browser.disconnect();
