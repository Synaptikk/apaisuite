// UAT 19059: the Find Injured Associate modal is open. Commit "Search By" = WIN with real mouse clicks, search, select, review.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const WIN = process.argv[2];
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = (await browser.pages()).find(x => /intakenotice\/19059/.test(x.url()));
await page.bringToFront();
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut|nr-data/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 300), body: (r.postData() || "").slice(0, 2500) }); });
page.on("response", async r => { const key = r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 300); const i = reqs.findIndex(x => x.u === key && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 5000); } catch {} } });
const inpage = (fn, ...a) => page.evaluate(fn, ...a);
const modalOpen = await inpage(() => !!document.querySelector(".slds-modal.slds-fade-in-open"));
if (!modalOpen) { await inpage(() => { const b = [...document.querySelectorAll("button, a")].find(x => /find injured associate/i.test(x.innerText || "")); b && b.click(); }); await sleep(5000); }
// Search By combobox: clear, click, pick the "WIN" option with a real click
const sb = await page.$("#SpecialAnalysis\\#320_id");
await sb.click({ clickCount: 3 }); await page.keyboard.press("Backspace"); await sleep(500); await sb.click(); await sleep(1500);
let optHandle = null;
for (const o of await page.$$("li.slds-listbox__item cs-lookup-item, li.slds-listbox__item")) { const t = ((await (await o.getProperty("textContent")).jsonValue()) || "").trim(); const box = await o.boundingBox(); if (box && /^WIN/.test(t)) { optHandle = o; break; } }
if (optHandle) { await optHandle.click(); console.log("clicked WIN option"); } else { await sb.type("WIN", { delay: 80 }); await sleep(1500); const os = await page.$$("[role='option'], .slds-listbox__option"); for (const o of os) { const box = await o.boundingBox(); if (box) { await o.click(); console.log("clicked first option after typing"); break; } } }
await sleep(1000);
console.log("Search By value:", await inpage(() => document.getElementById("SpecialAnalysis#320_id")?.value));
const wi = await page.$("#WALMARTIDENTIFICATIONNUMBER_INPUT"); await wi.click(); await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace"); await wi.type(WIN, { delay: 30 }); await page.keyboard.press("Tab"); await sleep(500);
reqs.length = 0;
let searchBtn = null;
for (const b of await page.$$(".slds-modal.slds-fade-in-open button")) { const t = ((await (await b.getProperty("innerText")).jsonValue()) || "").trim(); if (/^search$/i.test(t) && await b.boundingBox()) { searchBtn = b; break; } }
if (searchBtn) { await searchBtn.click(); console.log("Search clicked (mouse)"); } else { await page.keyboard.press("Enter"); console.log("Enter pressed"); }
await sleep(10000);
const modal = await inpage(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); return { text: (m?.innerText || "").replace(/\n+/g, " | ").slice(0, 1500), headers: [...(m?.querySelectorAll("th") || [])].map(h => h.innerText.trim()), rows: [...(m?.querySelectorAll("tbody tr, [role=row]") || [])].map(r => r.innerText.replace(/\s+/g, " ").slice(0, 200)) }; });
console.log("MODAL after search:", JSON.stringify(modal, null, 1));
await page.screenshot({ path: `${OUT}/win-3.png` });
console.log("SEARCH XHR:"); for (const r of reqs) console.log(" ", r.m, r.u.slice(0, 220), r.status, "\n    BODY:", r.body.slice(0, 600), "\n    RESP:", (r.resp || "").slice(0, 1200));
// select the row (real click on first selectable element) then Select and Review
let rowEl = null;
for (const r of await page.$$(".slds-modal.slds-fade-in-open tbody tr, .slds-modal.slds-fade-in-open [role=row]")) { const t = ((await (await r.getProperty("innerText")).jsonValue()) || ""); if (/\d{6,}/.test(t) && await r.boundingBox()) { rowEl = r; break; } }
if (rowEl) { const c = (await rowEl.$("input[type=radio], input[type=checkbox]")) || (await rowEl.$("td")); await c.click(); console.log("row clicked"); await sleep(1500); }
reqs.length = 0;
for (const b of await page.$$(".slds-modal.slds-fade-in-open button")) { const t = ((await (await b.getProperty("innerText")).jsonValue()) || "").trim(); if (/select and review/i.test(t) && await b.boundingBox()) { await b.click(); console.log("Select and Review clicked"); break; } }
await sleep(10000);
console.log("modal still open:", await inpage(() => !!document.querySelector(".slds-modal.slds-fade-in-open")));
console.log("modal text:", await inpage(() => (document.querySelector(".slds-modal.slds-fade-in-open")?.innerText || "").replace(/\n+/g, " | ").slice(0, 800)));
const dump = await inpage(() => { const t = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim(); const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rows = []; document.querySelectorAll("input:not([type=hidden]), textarea").forEach(el => { if (!v(el)) return; let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = t(l); } if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && v(l)) label = t(l); } } if (!label && el.type === "radio") label = (el.id || "").replace(/^radio-/, "").replace(/-STARS_\d+$/, ""); const m = (el.id || el.name || "").match(/STARS_\d+/); rows.push({ star: m ? m[0] : "", type: el.type || el.tagName, label: label.slice(0, 90), val: (el.value || "").slice(0, 40), checked: el.checked }); }); return { rows, text: document.body.innerText }; });
console.log("CONTROLS:", dump.rows.length); for (const r of dump.rows) console.log(`  ${(r.star || "").padEnd(10)} ${String(r.type).padEnd(9)} ${r.label}${r.val ? " = " + r.val : ""}${r.checked ? " [x]" : ""}`);
writeFileSync(`${OUT}/win-page.txt`, dump.text); writeFileSync(`${OUT}/win-xhr2.json`, JSON.stringify(reqs, null, 1));
await page.screenshot({ path: `${OUT}/win-4.png`, fullPage: true });
console.log("REVIEW XHR:"); for (const r of reqs) console.log(" ", r.m, r.u.slice(0, 200), r.status, "\n    BODY:", r.body.slice(0, 800), "\n    RESP:", (r.resp || "").slice(0, 600));
await browser.disconnect();
