// UAT notice 19060: generic walker — fill every visible required control with TEST values, dump, Next; stop at the Summary page (never clicks Submit).
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = (process.argv.find(a => a.startsWith("--notice=")) || "--notice=19060").slice(9);
const MAXPAGES = Number((process.argv.find(a => a.startsWith("--pages=")) || "--pages=8").slice(8));
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => new RegExp("intakenotice/" + NOTICE).test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reqs = [];
page.on("request", r => { if (r.method() === "POST" && /SaveInterview|InterviewUpdate|Submit/i.test(r.url())) reqs.push({ u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 120), body: r.postData() || "" }); });
const dump = () => page.evaluate(() => {
  const txt = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const steps = [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(txt).filter(Boolean))];
  const rows = [];
  document.querySelectorAll("input:not([type=hidden]), select, textarea").forEach(el => {
    if (!vis(el)) return;
    let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = txt(l); }
    if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && vis(l)) label = txt(l); } }
    if (!label && el.type === "radio") label = (el.id || "").replace(/^radio-/, "").replace(/-STARS_\d+$/, "");
    const m = (el.id || el.name || "").match(/STARS_\d+/); const star = m ? m[0] : "";
    const req = !!(el.required || el.getAttribute("aria-required") === "true" || el.closest(".slds-form-element")?.querySelector("abbr.slds-required, .slds-required") || label.startsWith("*"));
    rows.push({ star, tag: el.tagName, type: el.type || "", id: el.id, name: el.name, label: label.slice(0, 110), req, val: (el.value || "").slice(0, 50), checked: el.checked });
  });
  const errors = [...document.querySelectorAll(".slds-has-error, .invalid-feedback, [class*='error']")].filter(vis).map(txt).filter(t => t && t.length < 200);
  return { url: location.href, steps, rows, errors, text: document.body.innerText };
});
const fillOnce = async () => {
  const d = await dump(); let did = 0;
  const seenRadio = new Set();
  for (const r of d.rows) {
    if (r.tag === "INPUT" && r.type === "radio") {
      if (seenRadio.has(r.name)) continue; seenRadio.add(r.name);
      const group = d.rows.filter(x => x.name === r.name);
      if (group.some(x => x.checked)) continue;
      const pick = group.find(x => /^(N|NO)$/i.test(x.val)) || group.find(x => /^A$/i.test(x.val)) || group[0];
      await page.evaluate((id) => document.getElementById(id)?.click(), pick.id); did++; await sleep(1200); continue;
    }
    if (r.tag === "INPUT" && r.type === "checkbox") { if (!r.checked) { await page.evaluate((id) => document.getElementById(id)?.click(), r.id); did++; await sleep(400); } continue; }
    if (r.val) continue;
    if (!r.req && !/datepicker/.test(r.name || "")) continue;
    const sel = r.id ? `#${CSS_escape(r.id)}` : `[name="${r.name}"]`;
    const el = await page.$(sel); if (!el) continue;
    const lab = (r.label + " " + r.id).toLowerCase();
    if (/_id$/.test(r.id) || /combobox/.test(r.id)) { // SLDS combobox: open and pick first option
      await el.click(); await sleep(1500);
      const picked = await page.evaluate(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option")].find(x => x.getBoundingClientRect().width > 0); if (o) { o.click(); return o.textContent.trim().slice(0, 40); } return null; });
      if (!picked) { await el.type("A", { delay: 50 }); await sleep(1500); await page.evaluate(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option")].find(x => x.getBoundingClientRect().width > 0); o && o.click(); }); }
      did++; await sleep(800); continue;
    }
    let v = "TEST";
    if (/datepicker/.test(r.name || "") || /date/.test(lab)) v = "9/16/2026";
    else if (/phone|contact #/.test(lab)) v = "555-555-0100";
    else if (/email/.test(lab)) v = "apaisuite.test@example.com";
    else if (/zip/.test(lab)) v = "30742";
    else if (/city/.test(lab)) v = "Fort Oglethorpe";
    else if (/first name/.test(lab)) v = "APAISUITE";
    else if (/last name/.test(lab)) v = "TESTINCIDENT";
    else if (/signature name|name of person/.test(lab)) v = "SHANE SMITH";
    else if (/address|street/.test(lab)) v = "100 Test St";
    else if (/mileage|amount|hours|wage|#/.test(lab)) v = "1";
    else if (r.tag === "TEXTAREA") v = "TEST ENTRY - APAISuite probe, not a real incident.";
    await el.click({ clickCount: 3 }); await el.type(v, { delay: 15 }); await page.keyboard.press("Tab"); did++; await sleep(400);
  }
  return did;
};
function CSS_escape(s) { return s.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|\/@])/g, "\$1"); }
for (let p = 0; p < MAXPAGES; p++) {
  let d = await dump();
  const pageName = d.steps[d.steps.length - 1];
  console.log(`\n===== PAGE ${p}: ${pageName}`);
  for (let round = 0; round < 6; round++) { const n = await fillOnce(); if (!n) break; }
  d = await dump();
  for (const r of d.rows) console.log(`${r.req ? "*" : " "} ${(r.star || "").padEnd(10)} ${r.tag.padEnd(8)} ${(r.type || "").padEnd(8)} ${r.label}${r.val ? " = " + r.val : ""}${r.checked ? " [x]" : ""}`);
  writeFileSync(`${OUT}/walk-${NOTICE}-${p}-${pageName.replace(/[^a-z0-9]+/gi, "_")}.txt`, d.text);
  await page.screenshot({ path: `${OUT}/walk-${NOTICE}-${p}.png`, fullPage: true });
  const hasSubmit = await page.evaluate(() => !![...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0));
  if (hasSubmit) { console.log("SUMMARY PAGE reached — Submit button present, not clicking."); break; }
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log("Next:", clicked); await sleep(9000);
  const d2 = await dump();
  if (d2.steps[d2.steps.length - 1] === pageName) { console.log("STILL ON PAGE. errors:", JSON.stringify(d2.errors.slice(0, 10))); console.log(d2.text.replace(/\n+/g, " | ").slice(300, 1500)); break; }
}
writeFileSync(`${OUT}/walk-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
await browser.disconnect();
