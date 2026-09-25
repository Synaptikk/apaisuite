// UAT TEST EVENT #3 (company property damage path): New Incident → StartPage via API (CPD) → photos → auto-walk to the PR_Summary, dumping each page. Does not submit.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 1. list tab → New Incident
let list = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice$/.test(p.url()));
if (!list) { list = await browser.newPage(); await list.goto("https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/#/intake/stars.intakenotice", { waitUntil: "domcontentloaded" }); await sleep(10000); }
await list.bringToFront();
try { await list.evaluate(() => document.title); } catch { const s = await list.createCDPSession(); await s.send("Page.reload"); await sleep(10000); }
const known = new Set((await browser.pages()).map(p => p.url()));
await list.evaluate(() => { const b = [...document.querySelectorAll("button, a")].find(b => /^new incident$/i.test((b.innerText || "").trim())); b && b.click(); });
let page = null;
for (let i = 0; i < 15 && !page; i++) { await sleep(2000); page = (await browser.pages()).find(p => /intakenotice\/\d+/.test(p.url()) && !known.has(p.url())); }
if (!page) { console.log("no new notice"); process.exit(1); }
const m = page.url().match(/intakenotice\/(\d+).*answerId=(\d+)/); const NOTICE = Number(m[1]), ANSWER = Number(m[2]);
console.log("NEW NOTICE:", NOTICE, "answer", ANSWER);
await page.bringToFront(); await sleep(8000);
// 2. StartPage via API replay (recorded body from 19059, patched for CPD)
const rec = JSON.parse(readFileSync(`${OUT}/step1-xhr.json`, "utf8"));
const upd = JSON.parse(rec.find(r => r.u.includes("InterviewUpdate")).body);
const sav = JSON.parse(rec.find(r => r.u.includes("SaveInterview")).body);
const patch = (fv) => { Object.assign(fv, { STARS_458: "9/16/2026", STARS_464: "1400", STARS_792: "2645", STARS_56: "2645", STARS_560: "2645", STARS_184: "9/16/2026", STARS_454: "CPD", STARS_7: "", STARS_312: "", STARS_10: "", STARS_322: "", STARS_950: "", STARS_11: "5555550100", STARS_26: "SHANE SMITH - SES008S.S01458" }); fv.STARS_464Lookup = { Fieldname: null, Code: "1400", Description: "2:00 PM", Value: "1400", SortId: 0, Selected: false }; fv.STARS_792Lookup = { Fieldname: null, Code: "1458", Description: "1458 - FORT OGLETHORPE BATTLEFIELD PARKWAY", Value: "2645", SortId: 0, Selected: false }; return fv; };
upd.AnswersId = ANSWER; patch(upd.DataDictionary);
sav.AnswersId = ANSWER; sav.NoticeId = NOTICE; patch(sav.FieldValues); sav.VisitedPages = ["STARS_0", "STARS_1"]; sav.PageId = "Page_STARS_1"; sav.InvalidQuestions = JSON.stringify({ PSTARS_0: [] });
const post = (u, body) => page.evaluate(async (u, body) => { const tok = (await (await fetch("https://uat.riskonnectclearsight.com/Enterprise/StarsOne.mvc/StormsIntake?shellApp=rk-clearsight&appName=Intake&clearsight=true", { credentials: "include" })).json()).Token; const r = await fetch(u, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", custheader: tok, Accept: "application/json, text/plain, */*" }, body }); return { s: r.status, t: (await r.text()).slice(0, 80) }; }, u, JSON.stringify(body));
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Application/Orion.InterviewAnswers.mvc/MetaData";
console.log("InterviewUpdate:", JSON.stringify(await post(`${base}/InterviewUpdate?appName=Intake&clearsight=true`, upd)));
console.log("SaveInterview:", JSON.stringify(await post(`${base}/SaveInterview?appName=Intake&clearsight=true`, sav)));
await page.reload({ waitUntil: "domcontentloaded" }); await sleep(12000);
const inpage = (fn, ...a) => page.evaluate(fn, ...a);
const steps = () => inpage(() => [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean))]);
const dump = () => inpage(() => { const t = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim(); const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rows = []; document.querySelectorAll("input:not([type=hidden]), select, textarea").forEach(el => { if (!v(el)) return; let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = t(l); } if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && v(l)) label = t(l); } } if (!label && el.type === "radio") label = (el.id || "").replace(/^radio-/, "").replace(/-STARS_\d+$/, ""); const m = (el.id || el.name || "").match(/STARS_\d+/); const req = !!(el.required || el.getAttribute("aria-required") === "true" || el.closest(".slds-form-element")?.querySelector("abbr.slds-required, .slds-required") || label.startsWith("*")); rows.push({ star: m ? m[0] : "", tag: el.tagName, type: el.type || "", id: el.id, name: el.name, label: label.slice(0, 100), req, val: (el.value || "").slice(0, 50), checked: el.checked }); }); return { rows, text: document.body.innerText }; });
const CSS_escape = s => s.replace(/([ #;?%&,.+*~':"!^$[\]()=>|\/@])/g, "\\$1");
const fillOnce = async () => {
  const d = await dump(); let did = 0; const seen = new Set();
  for (const r of d.rows) {
    if (r.type === "radio") { if (seen.has(r.name)) continue; seen.add(r.name); const g = d.rows.filter(x => x.name === r.name); if (g.some(x => x.checked)) continue; const pick = g.find(x => /^(N|NO)$/i.test(x.val)) || g[0]; await inpage((id) => document.getElementById(id)?.click(), pick.id); did++; await sleep(1200); continue; }
    if (r.type === "checkbox") { if (!r.checked) { await inpage((id) => document.getElementById(id)?.click(), r.id); did++; await sleep(400); } continue; }
    if (r.val) continue;
    const isCombo = /_id$/.test(r.id);
    if (!r.req && !isCombo && !/datepicker/.test(r.name || "")) continue;
    const el = await page.$(r.id ? `#${CSS_escape(r.id)}` : `[name="${r.name}"]`); if (!el) continue;
    if (isCombo) { await el.click(); await sleep(2000); let h = null; for (const o of await page.$$("li.slds-listbox__item cs-lookup-item")) { if (await o.boundingBox()) { h = o; break; } } if (h) { await h.click(); did++; } await sleep(800); await page.keyboard.press("Escape"); continue; }
    const lab = (r.label + " " + r.id).toLowerCase(); let v = "TEST";
    if (/datepicker/.test(r.name || "") || /date/.test(lab)) v = "9/16/2026"; else if (/phone|contact #/.test(lab)) v = "555-555-0100"; else if (/email/.test(lab)) v = "apaisuite.test@example.com"; else if (/zip/.test(lab)) v = "30742"; else if (/city/.test(lab)) v = "Fort Oglethorpe"; else if (/first name/.test(lab)) v = "APAISUITE"; else if (/last name/.test(lab)) v = "TESTINCIDENT"; else if (/signature|name of person|manager/.test(lab)) v = "SHANE SMITH"; else if (/address|street/.test(lab)) v = "100 Test St"; else if (/amount|mileage|hours|wage|#|number|cost|value|estimate/.test(lab)) v = "1"; else if (r.tag === "TEXTAREA") v = "TEST ENTRY - APAISuite probe, not a real incident.";
    await el.click({ clickCount: 3 }); await el.type(v, { delay: 15 }); await page.keyboard.press("Tab"); did++; await sleep(400);
  }
  return did;
};
for (let p = 0; p < 7; p++) {
  const st = await steps(); const pageName = st[st.length - 1];
  console.log(`\n===== PAGE ${p}: ${pageName}`);
  if (pageName === "Photo Evidence") {
    await inpage(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(3000);
    const fi = await page.$(".slds-modal input[type=file]");
    if (fi) { await fi.uploadFile(`${OUT}/TEST_photo_1.png`, `${OUT}/TEST_photo_2.png`, `${OUT}/TEST_photo_3.png`); await sleep(3000); await inpage(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = [...m.querySelectorAll("button")].find(b => /^upload file$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(8000); await inpage(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = m && [...m.querySelectorAll("button")].find(b => /^done$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(2000); console.log("photos uploaded"); }
  } else if (pageName !== "StartPage") {
    for (let round = 0; round < 6; round++) { const n = await fillOnce(); if (!n) break; }
    const d = await dump();
    for (const r of d.rows) console.log(`${r.req ? "*" : " "} ${(r.star || "").padEnd(10)} ${r.tag.padEnd(8)} ${(r.type || "").padEnd(8)} ${r.label}${r.val ? " = " + r.val : ""}${r.checked ? " [x]" : ""}`);
    writeFileSync(`${OUT}/walk-${NOTICE}-${p}-${pageName.replace(/[^a-z0-9]+/gi, "_")}.txt`, d.text);
  }
  await page.screenshot({ path: `${OUT}/walk-${NOTICE}-${p}.png`, fullPage: true });
  const hasSubmit = await inpage(() => !![...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0));
  if (hasSubmit) { console.log("SUMMARY PAGE reached — not submitting."); break; }
  const clicked = await inpage(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log("Next:", clicked); if (!clicked) { console.log((await inpage(() => document.body.innerText)).replace(/\n+/g, " | ").slice(300, 1500)); break; } await sleep(9000);
}
await browser.disconnect();
