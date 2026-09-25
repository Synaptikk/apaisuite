import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const page = (await browser.pages()).find(x => /intakenotice\/19059/.test(x.url()));
await page.bringToFront();
await page.evaluate(() => document.getElementById("radio-Management or HR entering incident-STARS_268")?.click());
await new Promise(r => setTimeout(r, 4000));
const dump = await page.evaluate(() => { const t = el => ((el && (el.innerText ?? el.textContent)) || "").toString().replace(/\s+/g, " ").trim(); const v = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rows = []; document.querySelectorAll("input:not([type=hidden]), textarea").forEach(el => { if (!v(el)) return; let label = ""; if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) label = t(l); } if (!label) { let n = el; for (let d = 0; d < 6 && n && !label; d++) { n = n.parentElement; if (!n) break; const l = n.querySelector("label, .slds-form-element__label, legend"); if (l && v(l)) label = t(l); } } if (!label && el.type === "radio") label = (el.id || "").replace(/^radio-/, "").replace(/-STARS_\d+$/, ""); const m = (el.id || el.name || "").match(/STARS_\d+/); rows.push({ star: m ? m[0] : "", type: el.type || el.tagName, label: label.slice(0, 80), filled: !!(el.value || "").trim(), checked: el.checked }); }); return rows; });
for (const r of dump) console.log(`  ${(r.star || "").padEnd(10)} ${String(r.type).padEnd(9)} ${r.label}${r.filled ? " = <filled>" : ""}${r.checked ? " [x]" : ""}`);
await browser.disconnect();
