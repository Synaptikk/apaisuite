// dev/probe-clearsight-intake.mjs — READ-ONLY inventory of the Clearsight
// intake form (SPA). Never clicks Save/Submit/Next. Logs XHR endpoints seen.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const URL = process.argv[2] || "https://www.riskonnectclearsight.com/Walmart/app/Clearsight/#/intake/stars.intakenotice";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const pages = await browser.pages();
let page = pages.find(p => p.url().includes("riskonnectclearsight.com"));
if (!page) page = await browser.newPage();
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if (t === "xhr" || t === "fetch") reqs.push({ m: r.method(), u: r.url().slice(0, 220), body: (r.postData() || "").slice(0, 300) }); });
if (page.url() !== URL) await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();
let text = "";
for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 2000)); text = await page.evaluate(() => document.body.innerText || ""); if (text.length > 400) break; }
console.log("URL:", page.url());
const dump = await page.evaluate(() => {
  const txt = el => ((el && (el.innerText ?? el.textContent)) || "").toString().trim();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labelFor = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return txt(l); }
    const al = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"); if (al) return al;
    const wrap = el.closest("label"); if (wrap) return txt(wrap);
    let n = el; for (let d = 0; d < 5 && n; d++) { n = n.parentElement; const l2 = n && n.querySelector("label, .control-label, [class*='label']"); if (l2) return txt(l2); }
    return "";
  };
  const out = [];
  document.querySelectorAll("input, select, textarea, [contenteditable='true'], [role='combobox'], [role='textbox'], [role='radio'], [role='checkbox'], [role='listbox']").forEach(el => {
    if (el.type === "hidden") return;
    const opts = el.tagName === "SELECT" ? [...el.options].map(o => txt(o)).slice(0, 80) : undefined;
    out.push({ tag: el.tagName, type: el.type || el.getAttribute("role"), id: el.id, name: el.name || el.getAttribute("data-field") || el.getAttribute("formcontrolname") || el.getAttribute("ng-model") || el.getAttribute("data-bind") || el.getAttribute("data-id"),
      ph: el.placeholder, label: labelFor(el).slice(0, 90), req: !!(el.required || el.getAttribute("aria-required") === "true" || el.closest(".required, [class*='required']")), vis: vis(el),
      cls: (el.className || "").toString().slice(0, 80), val: (el.value || "").toString().slice(0, 40), opts });
  });
  const buttons = [...document.querySelectorAll("button, a.btn, [role='button'], input[type=submit], [class*='button']")].filter(vis).map(b => (txt(b) || b.value || b.title || b.getAttribute("aria-label") || "").trim()).filter(Boolean);
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,legend,[class*='title'],[class*='header']")].filter(vis).map(txt).filter(t => t && t.length < 120);
  const attrs = {}; document.querySelectorAll("[ng-app],[ng-version],[data-reactroot],[data-v-app]").forEach(e => { for (const a of e.attributes) attrs[a.name] = a.value; });
  return { controls: out, buttons: [...new Set(buttons)], heads: [...new Set(heads)], attrs, html: document.documentElement.outerHTML };
});
console.log("FRAMEWORK:", JSON.stringify(dump.attrs));
console.log("HEADINGS:", JSON.stringify(dump.heads, null, 1));
console.log("BUTTONS:", JSON.stringify(dump.buttons, null, 1));
console.log("CONTROLS:", dump.controls.length);
console.log(JSON.stringify(dump.controls, null, 1));
console.log("XHR:", JSON.stringify(reqs, null, 1));
console.log("BODY:", text.slice(0, 4000));
writeFileSync(`${OUT}/intake-page.html`, dump.html);
await browser.disconnect();
