// UAT: attach to the open intake notice tab, dump controls + resource URLs, refetch interview metadata.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
if (!page) { console.log("no notice tab"); process.exit(1); }
await page.bringToFront();
await new Promise(r => setTimeout(r, 3000));
console.log("URL:", page.url());
const res = await page.evaluate(() => performance.getEntriesByType("resource").map(e => e.name).filter(n => /\.mvc\/|api\//i.test(n)));
console.log("RESOURCES:", JSON.stringify(res, null, 1));
const dump = await page.evaluate(() => {
  const txt = el => ((el && (el.innerText ?? el.textContent)) || "").toString().trim();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labelFor = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return txt(l); }
    const al = el.getAttribute("aria-label"); if (al) return al;
    const alb = el.getAttribute("aria-labelledby"); if (alb) { const t = alb.split(/\s+/).map(i => txt(document.getElementById(i))).filter(Boolean).join(" "); if (t) return t; }
    const wrap = el.closest("label"); if (wrap) return txt(wrap);
    let n = el; for (let d = 0; d < 6 && n; d++) { n = n.parentElement; const l2 = n && n.querySelector("label, .slds-form-element__label, [class*='label']"); if (l2) return txt(l2); }
    return "";
  };
  const out = [];
  document.querySelectorAll("input, select, textarea, [contenteditable='true'], [role='combobox'], [role='textbox'], [role='radio'], [role='checkbox'], [role='listbox'], lightning-input, [data-fieldname], [fieldname]").forEach(el => {
    if (el.type === "hidden") return;
    const opts = el.tagName === "SELECT" ? [...el.options].map(o => txt(o)).slice(0, 80) : undefined;
    const fe = el.closest("[data-fieldname],[fieldname],[data-field],[id^='field'],[class*='question']");
    out.push({ tag: el.tagName, type: el.type || el.getAttribute("role"), id: el.id, name: el.name || el.getAttribute("formcontrolname") || el.getAttribute("data-fieldname") || el.getAttribute("fieldname"),
      fieldEl: fe ? { tag: fe.tagName, id: fe.id, fn: fe.getAttribute("data-fieldname") || fe.getAttribute("fieldname") || fe.getAttribute("data-field"), cls: (fe.className||"").toString().slice(0,60) } : null,
      ph: el.placeholder, label: labelFor(el).slice(0, 100), req: !!(el.required || el.getAttribute("aria-required") === "true" || el.closest(".slds-is-required, .required, [class*='required']") || (el.closest(".slds-form-element")?.querySelector("abbr.slds-required"))), vis: vis(el),
      cls: (el.className || "").toString().slice(0, 70), val: (el.value || "").toString().slice(0, 40), opts });
  });
  const buttons = [...document.querySelectorAll("button, a.btn, [role='button'], input[type=submit]")].filter(vis).map(b => (txt(b) || b.value || b.title || b.getAttribute("aria-label") || "").trim()).filter(Boolean);
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,legend,[class*='section'] > *:first-child, .slds-section__title, .slds-card__header-title")].filter(vis).map(txt).filter(t => t && t.length < 120);
  const tabs = [...document.querySelectorAll("[role='tab'], .slds-tabs_default__link, .slds-path__link, [class*='step'], [class*='wizard'] li")].map(txt).filter(Boolean);
  return { controls: out, buttons: [...new Set(buttons)], heads: [...new Set(heads)], tabs: [...new Set(tabs)], html: document.documentElement.outerHTML, text: document.body.innerText };
});
console.log("TABS/STEPS:", JSON.stringify(dump.tabs));
console.log("HEADINGS:", JSON.stringify(dump.heads, null, 1));
console.log("BUTTONS:", JSON.stringify(dump.buttons, null, 1));
console.log("CONTROLS:", dump.controls.length);
console.log(JSON.stringify(dump.controls, null, 1));
writeFileSync(`${OUT}/uat-notice-page.html`, dump.html);
writeFileSync(`${OUT}/uat-notice-page.txt`, dump.text);
console.log("BODY:", dump.text.slice(0, 6000));
await browser.disconnect();
