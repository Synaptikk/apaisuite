// UAT: click "Attach Photos" on the Photo Evidence page and describe what opens (no upload yet).
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
await page.bringToFront();
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch" || t === "document") && !/nr-data|CheckForceLogOut/.test(r.url())) reqs.push({ m: r.method(), u: r.url().slice(0, 300), body: (r.postData() || "").slice(0, 500) }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const before = new Set((await browser.pages()).map(p => p.url()));
const ok = await page.evaluate(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); if (a) { a.click(); return true; } return false; });
console.log("clicked Attach Photos:", ok);
await sleep(5000);
const pagesNow = await browser.pages();
const newPages = pagesNow.filter(p => !before.has(p.url()));
console.log("new pages:", newPages.map(p => p.url()));
console.log("frames:", page.frames().map(f => f.url()));
const target = newPages[0] || page;
const dump = await target.evaluate(() => {
  const txt = el => ((el && (el.innerText ?? el.textContent)) || "").toString().trim();
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const modal = document.querySelector(".slds-modal, [role='dialog'], .modal, cs-attachment, [class*='attach']");
  const root = modal || document.body;
  return {
    modalTag: modal ? modal.tagName + "." + (modal.className || "").toString().slice(0, 80) : null,
    text: txt(root).slice(0, 2500),
    inputs: [...root.querySelectorAll("input, select, textarea, button, [role='button']")].map(e => ({ tag: e.tagName, type: e.type, id: e.id, name: e.name, accept: e.accept, multiple: e.multiple, txt: txt(e).slice(0, 60), vis: vis(e) })).filter(e => e.vis || e.type === "file"),
    iframes: [...document.querySelectorAll("iframe")].map(f => f.src),
  };
});
console.log(JSON.stringify(dump, null, 1));
for (const f of target.frames()) { if (f !== target.mainFrame()) { try { const t = await f.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1500), files: [...document.querySelectorAll("input[type=file]")].map(e => ({ id: e.id, name: e.name, accept: e.accept, multiple: e.multiple })), forms: [...document.querySelectorAll("form")].map(f => f.action) })); console.log("FRAME:", JSON.stringify(t, null, 1)); } catch (e) { console.log("frame err", f.url(), e.message); } } }
await target.screenshot({ path: `${OUT}/uat-attach.png` });
console.log("XHR:", JSON.stringify(reqs, null, 1));
writeFileSync(`${OUT}/attach-page.html`, await target.content());
await browser.disconnect();
