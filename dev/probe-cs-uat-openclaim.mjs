// UAT: from the quick-search results already shown in the list tab, click Open on the claim row, then map the incident folder + Evidence Collection page.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const CLAIM = "26005842";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const known = new Set((await browser.pages()).filter(p => /riskonnect/.test(p.url())).map(p => p.url()));
const findNew = async (cur) => (await browser.pages()).find(p => /riskonnect/.test(p.url()) && !known.has(p.url()) && p !== cur);
let page = (await browser.pages()).find(x => /uat\.riskonnectclearsight\.com.*intakenotice$/.test(x.url()));
await page.bringToFront();
const reqs = [];
const hook = (pg) => pg.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut|nr-data/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 260), body: (r.postData() || "").slice(0, 400) }); });
hook(page);
const txt = (pg) => pg.evaluate(() => document.body.innerText);
const hasResult = (await txt(page)).includes(CLAIM);
if (!hasResult) { const qs = await page.$("#quick-search-input-text"); await qs.click({ clickCount: 3 }); await qs.type(CLAIM, { delay: 30 }); await page.keyboard.press("Enter"); await sleep(12000); }
const opened = await page.evaluate(() => { const v = el => el.getBoundingClientRect().width > 0; const b = [...document.querySelectorAll("button, a")].filter(v).find(x => /^open$/i.test((x.innerText || x.title || x.getAttribute("aria-label") || "").trim()) && !x.closest("header")); if (b) { b.click(); return (b.title || b.getAttribute("aria-label") || b.innerText || "").trim(); } return null; });
console.log("clicked:", opened); await sleep(12000);
const np = await findNew(page); if (np) { page = np; hook(page); await page.bringToFront(); await sleep(3000); }
console.log("FOLDER URL:", page.url());
const menu = await page.evaluate(() => [...new Set([...document.querySelectorAll("nav li, aside li, [class*=sub-menu] li, [role=tab], [class*=nav] a, [class*=menu] a, li a, li span")].filter(e => e.getBoundingClientRect().width > 0).map(e => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(x => x && x.length < 70))]);
console.log("MENU:", JSON.stringify(menu));
console.log("TEXT:", (await txt(page)).replace(/\n+/g, " | ").slice(0, 2500));
await page.screenshot({ path: `${OUT}/claim-1.png`, fullPage: true });
const ev = await page.evaluate(() => { const c = [...document.querySelectorAll("a, li, button, span, div")].filter(x => x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().width < 500).find(x => /evidence collection/i.test(x.innerText || "") && (x.innerText || "").length < 80); if (c) { c.click(); return (c.innerText || "").trim(); } return null; });
console.log("evidence page click:", ev); await sleep(12000);
console.log("EVIDENCE URL:", page.url());
const dump = await page.evaluate(() => { const t = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim(); const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rows = []; document.querySelectorAll("input:not([type=hidden]), select, textarea, [role=combobox]").forEach(el => { if (!v(el)) return; let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = t(l); } if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && v(l)) label = t(l); } } rows.push({ id: el.id, name: el.name, type: el.type || el.tagName, label: label.slice(0, 100), val: (el.value || "").slice(0, 40) }); }); const sections = [...document.querySelectorAll("h1,h2,h3,h4,legend,.slds-section__title,[class*=section-title],[class*=header-title],.slds-card__header-title")].filter(v).map(t).filter(x => x && x.length < 90); return { rows, sections: [...new Set(sections)], text: document.body.innerText }; });
console.log("SECTIONS:", JSON.stringify(dump.sections));
console.log("CONTROLS:", dump.rows.length); for (const r of dump.rows) console.log(`  ${(r.id || r.name || "").padEnd(40)} ${String(r.type).padEnd(10)} ${r.label}${r.val ? " = " + r.val : ""}`);
console.log("TEXT:", dump.text.replace(/\n+/g, " | ").slice(0, 5000));
writeFileSync(`${OUT}/evidence-page.html`, await page.content()); writeFileSync(`${OUT}/evidence-page.txt`, dump.text);
await page.screenshot({ path: `${OUT}/claim-2.png`, fullPage: true });
writeFileSync(`${OUT}/openclaim-xhr.json`, JSON.stringify(reqs, null, 1));
console.log("XHR paths:", JSON.stringify([...new Set(reqs.map(r => r.m + " " + r.u.split("?")[0]))], null, 1));
await browser.disconnect();
