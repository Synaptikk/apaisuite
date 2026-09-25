// UAT notice 19060: click Submit on the Summary page, handle any confirm dialog, record requests and the result.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = (process.argv.find(a => a.startsWith("--notice=")) || "--notice=19060").slice(9);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => new RegExp("intakenotice/" + NOTICE).test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 160), body: r.postData() || "" }); });
page.on("response", async r => { const key = r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 160); const i = reqs.findIndex(x => x.u === key && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 2500); } catch {} } });
const modalText = () => page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); return m ? { text: (m.innerText || "").replace(/\n+/g, " | ").slice(0, 800), buttons: [...m.querySelectorAll("button")].map(b => (b.innerText || "").trim()).filter(Boolean) } : null; });
const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
console.log("Submit clicked:", clicked);
for (let i = 0; i < 6; i++) {
  await sleep(4000);
  const m = await modalText();
  if (m) { console.log("MODAL:", JSON.stringify(m)); await page.screenshot({ path: `${OUT}/submit-${NOTICE}-modal${i}.png` });
    const ok = await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); const b = [...m.querySelectorAll("button")].find(b => /^(yes|ok|confirm|submit|continue)$/i.test((b.innerText || "").trim())); if (b) { b.click(); return b.innerText.trim(); } return null; });
    console.log("modal button clicked:", ok); if (!ok) break; }
  else break;
}
await sleep(8000);
console.log("URL:", page.url());
const txt = await page.evaluate(() => document.body.innerText);
console.log("PAGE:", txt.replace(/\n+/g, " | ").slice(0, 2500));
await page.screenshot({ path: `${OUT}/submit-${NOTICE}-result.png`, fullPage: true });
writeFileSync(`${OUT}/submit-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
console.log("XHR:", JSON.stringify(reqs.map(r => ({ m: r.m, u: r.u.slice(0, 120), status: r.status, body: r.body.slice(0, 200), resp: (r.resp || "").slice(0, 400) })), null, 1));
await browser.disconnect();
