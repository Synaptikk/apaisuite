// UAT: open "Find Injured Associate", describe the lookup modal, search for the signed-in user, pick the first row.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && !/nr-data|CheckForceLogOut/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 400), body: (r.postData() || "").slice(0, 800) }); });
page.on("response", async r => { const i = reqs.findIndex(x => r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").startsWith(x.u.slice(0, 80)) && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 1200); } catch {} } });
const describeModal = async (label) => {
  const m = await page.evaluate(() => {
    const txt = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim();
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role='dialog']")].pop();
    if (!m) return null;
    const controls = [...m.querySelectorAll("input:not([type=hidden]), select, textarea, button")].filter(vis).map(e => { let label = ""; if (e.id) { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l) label = txt(l); } if (!label) { const fe = e.closest(".slds-form-element"); const l = fe && fe.querySelector("label"); if (l) label = txt(l); } return { tag: e.tagName, type: e.type, id: e.id, name: e.name, ph: e.placeholder, label, btn: e.tagName === "BUTTON" ? txt(e) : undefined }; });
    const headers = [...m.querySelectorAll("th")].map(txt).filter(Boolean);
    const rows = [...m.querySelectorAll("tbody tr")].length;
    return { text: txt(m).slice(0, 1200), controls, headers, rows };
  });
  console.log(`MODAL[${label}]:`, JSON.stringify(m, null, 1));
  return m;
};
const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll("button, a")].find(x => /find injured associate/i.test(x.innerText || "")); if (b) { b.click(); return true; } return false; });
console.log("clicked Find:", clicked);
await sleep(5000);
await page.screenshot({ path: `${OUT}/uat-find-1.png` });
let m = await describeModal("open");
if (m) {
  // fill the first two visible text inputs with the user's name if they look like first/last, else quick search
  const inputs = m.controls.filter(c => c.tag === "INPUT" && (c.type === "text" || c.type === "search" || !c.type));
  console.log("text inputs:", JSON.stringify(inputs));
  const setVal = async (idx, val) => { const el = (await page.$$(".slds-modal.slds-fade-in-open input:not([type=hidden]), [role='dialog'] input:not([type=hidden])")); const vis = []; for (const e of el) { if (await e.boundingBox()) vis.push(e); } if (vis[idx]) { await vis[idx].click({ clickCount: 3 }); await vis[idx].type(val, { delay: 25 }); return true; } return false; };
  const li = inputs.findIndex(c => /last/i.test(c.label + c.ph + c.id + c.name));
  const fi = inputs.findIndex(c => /first/i.test(c.label + c.ph + c.id + c.name));
  if (li >= 0) await setVal(li, "SMITH");
  if (fi >= 0) await setVal(fi, "SHANE");
  if (li < 0 && fi < 0 && inputs.length) await setVal(0, "SMITH");
  await sleep(500);
  const searched = await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role='dialog']")].pop(); const b = [...m.querySelectorAll("button")].find(b => /search|go|find/i.test((b.innerText || b.title || "").trim())); if (b) { b.click(); return (b.innerText || b.title).trim(); } return null; });
  console.log("search clicked:", searched);
  if (!searched) await page.keyboard.press("Enter");
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/uat-find-2.png` });
  m = await describeModal("after search");
  // pick the first result row (row containing SES008S if present, else first)
  const picked = await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role='dialog']")].pop(); const rows = [...m.querySelectorAll("tbody tr")]; const r = rows.find(r => /SES008S/i.test(r.innerText)) || rows[0]; if (!r) return null; const a = r.querySelector("a, button, input[type=radio], input[type=checkbox]") || r.querySelector("td"); a.click(); return r.innerText.replace(/\s+/g, " ").slice(0, 200); });
  console.log("picked row:", picked);
  await sleep(4000);
  const sel = await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role='dialog']")].pop(); if (!m) return "modal closed"; const b = [...m.querySelectorAll("button")].find(b => /select|ok|done|choose/i.test((b.innerText || "").trim())); if (b) { b.click(); return "clicked " + b.innerText.trim(); } return "no select button"; });
  console.log("select:", sel);
  await sleep(6000);
}
await page.screenshot({ path: `${OUT}/uat-find-3.png`, fullPage: true });
writeFileSync(`${OUT}/find-xhr.json`, JSON.stringify(reqs, null, 1));
console.log("XHR:", JSON.stringify(reqs.map(r => ({ m: r.m, u: r.u.slice(0, 220), status: r.status, body: r.body.slice(0, 300), resp: (r.resp || "").slice(0, 400) })), null, 1));
await browser.disconnect();
