// UAT notice 19059: Find Injured Associate by WIN, record the lookup XHR, select the row, dump the auto-filled statement page.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const WIN = process.argv[2];
if (!WIN) { console.log("usage: node probe-cs-uat-win.mjs <WIN>"); process.exit(1); }
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let page = (await browser.pages()).find(x => /intakenotice\/19059/.test(x.url()));
const url = page ? page.url() : "https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/#/intake/stars.intakenotice/19059?isNew=true&groupKeys=&templateId=2383&answerId=19133";
if (page) { try { const s = await page.createCDPSession(); await s.send("Page.close"); } catch {} await sleep(1000); }
page = await browser.newPage();
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut|nr-data|InterviewLookup\?filter=&fieldName=STARS_(464|792)/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 300), body: (r.postData() || "").slice(0, 2500) }); });
page.on("response", async r => { const key = r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 300); const i = reqs.findIndex(x => x.u === key && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 4000); } catch {} } });
await page.goto(url, { waitUntil: "domcontentloaded" }); await page.bringToFront(); await sleep(12000);
const inpage = (fn, ...a) => page.evaluate(fn, ...a);
const steps = () => inpage(() => [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean))]);
// Next until WC_Associate Statement
for (let i = 0; i < 4; i++) {
  const st = await steps(); if (st[st.length - 1] === "WC_Associate Statement") break;
  if (st[st.length - 1] === "Photo Evidence") { await inpage(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(4000); await inpage(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = m && [...m.querySelectorAll("button")].find(b => /^(done|cancel|close)$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(1500); }
  const c = await inpage(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log("Next:", c, JSON.stringify(st)); if (!c) break; await sleep(8000);
}
console.log("at:", JSON.stringify(await steps()));
reqs.length = 0;
await inpage(() => { const b = [...document.querySelectorAll("button, a")].find(x => /find injured associate/i.test(x.innerText || "")); b && b.click(); }); await sleep(5000);
// Search By = WIN (combobox), then WIN number
const sb = await page.$("#SpecialAnalysis\\#320_id");
await sb.click(); await sleep(1500);
const picked = await inpage(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option")].find(x => /^WIN$/i.test(x.textContent.trim()) || /WIN/.test(x.textContent)) ; if (o) { o.click(); return o.textContent.trim(); } return null; });
console.log("Search By picked:", picked); await sleep(800);
if (!(await inpage(() => document.getElementById("SpecialAnalysis#320_id")?.value))) { await sb.type("WIN", { delay: 60 }); await sleep(1500); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await sleep(800); }
console.log("Search By value:", await inpage(() => document.getElementById("SpecialAnalysis#320_id")?.value));
const wi = await page.$("#WALMARTIDENTIFICATIONNUMBER_INPUT"); await wi.click({ clickCount: 3 }); await wi.type(WIN, { delay: 30 }); await sleep(500);
await inpage(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); const b = [...m.querySelectorAll("button")].find(b => /^search$/i.test((b.innerText || "").trim())); b && b.click(); });
await sleep(8000);
const modal = await inpage(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); return { text: (m?.innerText || "").replace(/\n+/g, " | ").slice(0, 1500), headers: [...(m?.querySelectorAll("th") || [])].map(h => h.innerText.trim()), rows: [...(m?.querySelectorAll("tbody tr, [role=row]") || [])].length }; });
console.log("MODAL after search:", JSON.stringify(modal));
await page.screenshot({ path: `${OUT}/win-1.png` });
// select the row (radio/checkbox/first cell) then Select and Review
const sel = await inpage(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); const r = [...m.querySelectorAll("tbody tr, [role=row]")].find(r => /\d{6,}/.test(r.innerText)); if (!r) return "no row"; const c = r.querySelector("input[type=radio], input[type=checkbox], a, button") || r.querySelector("td"); c.click(); return "row clicked: " + (c.tagName); });
console.log(sel); await sleep(1500);
await inpage(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); const b = [...m.querySelectorAll("button")].find(b => /select and review/i.test((b.innerText || "").trim())); b && b.click(); });
await sleep(10000);
const still = await inpage(() => !!document.querySelector(".slds-modal.slds-fade-in-open"));
console.log("modal still open:", still);
if (still) { console.log("modal text:", await inpage(() => (document.querySelector(".slds-modal.slds-fade-in-open")?.innerText || "").replace(/\n+/g, " | ").slice(0, 600))); }
const dump = await inpage(() => { const t = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim(); const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rows = []; document.querySelectorAll("input:not([type=hidden]), textarea").forEach(el => { if (!v(el)) return; let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = t(l); } if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && v(l)) label = t(l); } } if (!label && el.type === "radio") label = (el.id || "").replace(/^radio-/, "").replace(/-STARS_\d+$/, ""); const m = (el.id || el.name || "").match(/STARS_\d+/); rows.push({ star: m ? m[0] : "", type: el.type || el.tagName, label: label.slice(0, 90), val: (el.value || "").slice(0, 40), checked: el.checked }); }); return { rows, text: document.body.innerText }; });
console.log("CONTROLS:", dump.rows.length); for (const r of dump.rows) console.log(`  ${(r.star || "").padEnd(10)} ${String(r.type).padEnd(9)} ${r.label}${r.val ? " = " + r.val : ""}${r.checked ? " [x]" : ""}`);
writeFileSync(`${OUT}/win-page.txt`, dump.text); writeFileSync(`${OUT}/win-xhr.json`, JSON.stringify(reqs, null, 1));
await page.screenshot({ path: `${OUT}/win-2.png`, fullPage: true });
console.log("XHR:"); for (const r of reqs) console.log(" ", r.m, r.u.slice(0, 200), r.status, "\n    BODY:", r.body.slice(0, 500), "\n    RESP:", (r.resp || "").slice(0, 700));
await browser.disconnect();
