// UAT: close any modal, optionally click Next, then dump the current page's visible fields with their labels.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NEXT = process.argv.includes("--next");
const TAG = (process.argv.find(a => a.startsWith("--tag=")) || "--tag=page").slice(6);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const NOTICE = (process.argv.find(a => a.startsWith("--notice=")) || "--notice=").slice(9);
const page = (await browser.pages()).find(p => new RegExp("uat\.riskonnectclearsight\.com.*intakenotice/" + (NOTICE || "\d+")).test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && !/nr-data|CheckForceLogOut/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 200), body: (r.postData() || "").slice(0, 300) }); });
await page.evaluate(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); if (m) { const b = [...m.querySelectorAll("button")].find(b => /^(done|close)$/i.test((b.innerText || "").trim())); b && b.click(); } });
await sleep(1500);
if (NEXT) {
  const ok = await page.evaluate(() => { const b = [...document.querySelectorAll("button, a")].filter(b => (b.innerText || "").trim() === "Next").find(b => { const r = b.getBoundingClientRect(); return r.width > 0; }); if (b) { b.click(); return true; } return false; });
  console.log("clicked Next:", ok);
  await sleep(6000);
}
const dump = await page.evaluate(() => {
  const txt = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const steps = [...document.querySelectorAll("nav li, .slds-nav-vertical__item, [class*='sub-menu'] li, aside li")].map(txt).filter(Boolean);
  const heading = txt(document.querySelector("h1, h2, .slds-page-header__title, [class*='page-title']"));
  const rows = [];
  // walk every visible form element in DOM order; find its nearest label text
  document.querySelectorAll("input:not([type=hidden]), select, textarea, [role='combobox'] input, button").forEach(el => {
    if (!vis(el)) return;
    if (el.tagName === "BUTTON" && !/next|back|save|attach|sign|add|remove|delete|search|lookup/i.test(txt(el))) return;
    let label = "";
    const id = el.id; if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) label = txt(l); }
    if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend, [class*='label']"); if (l && vis(l)) label = txt(l); } }
    if (!label && el.type === "radio") label = (el.id || "").replace(/^radio-/, "").replace(/-STARS_\d+$/, "");
    const m = (el.id || el.name || "").match(/STARS_\d+/); const star = m ? m[0] : "";
    const req = !!(el.required || el.getAttribute("aria-required") === "true" || el.closest(".slds-form-element")?.querySelector("abbr.slds-required, .slds-required") || (label.startsWith("*")));
    rows.push({ star, tag: el.tagName, type: el.type || "", id: el.id, label: label.slice(0, 120), req, val: (el.value || "").slice(0, 60), checked: el.checked || undefined, btn: el.tagName === "BUTTON" ? txt(el) : undefined });
  });
  return { url: location.href, heading, steps: [...new Set(steps)], rows, text: document.body.innerText };
});
console.log("URL:", dump.url); console.log("STEPS:", JSON.stringify(dump.steps)); console.log("HEADING:", dump.heading);
console.log("CONTROLS:", dump.rows.length);
for (const r of dump.rows) console.log(`${r.req ? "*" : " "} ${(r.star || "").padEnd(10)} ${r.tag.padEnd(8)} ${(r.type || "").padEnd(8)} ${r.label}${r.val ? " = " + r.val : ""}${r.checked ? " [x]" : ""}${r.btn ? " <" + r.btn + ">" : ""}`);
writeFileSync(`${OUT}/uat-${TAG}.txt`, dump.text); writeFileSync(`${OUT}/uat-${TAG}.html`, await page.content());
await page.screenshot({ path: `${OUT}/uat-${TAG}.png`, fullPage: true });
console.log("XHR:", JSON.stringify(reqs.slice(0, 30), null, 0));
await browser.disconnect();
