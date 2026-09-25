// UAT incident 9498309 (claim 26005842): pull the folder metadata + form data, record what Save posts, and look at Attachments + Supplemental Information.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = (await browser.pages()).find(x => /claims\/stars\.incident\/9498309/.test(x.url()));
await page.bringToFront();
const prev = JSON.parse(readFileSync(`${OUT}/openclaim-xhr.json`, "utf8"));
const urls = { formData: prev.find(r => /STARS\.Incident\.mvc\/FormData/.test(r.u))?.u, folderMeta: prev.find(r => /CsFolderMetaData/.test(r.u))?.u, claimsAdmin: prev.find(r => /StormsClaimsAdmin/.test(r.u))?.u };
console.log("URLS:", JSON.stringify(urls));
for (const [k, u] of Object.entries(urls)) {
  if (!u) continue;
  const r = await page.evaluate(async (u) => { const r = await fetch("https://uat.riskonnectclearsight.com/Enterprise/" + u, { credentials: "include", headers: { Accept: "application/json" } }); return { s: r.status, t: await r.text() }; }, u);
  writeFileSync(`${OUT}/incident-${k}.json`, r.t);
  let keys = ""; try { const j = JSON.parse(r.t); keys = Array.isArray(j) ? `array[${j.length}]` : Object.keys(j).slice(0, 30).join(","); } catch { keys = "(not json)"; }
  console.log(k, r.s, r.t.length, "bytes ::", keys);
}
// record Save: type a test value into "Managers name and title" and click Save
const reqs = [];
page.on("request", r => { const t = r.resourceType(); if ((t === "xhr" || t === "fetch") && /riskonnect/.test(r.url()) && !/CheckForceLogOut|nr-data/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 260), headers: Object.fromEntries(Object.entries(r.headers()).filter(([k]) => /custheader|content-type/i.test(k))), body: (r.postData() || "").slice(0, 3000) }); });
page.on("response", async r => { const key = r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 260); const i = reqs.findIndex(x => x.u === key && x.resp === undefined); if (i >= 0) { try { reqs[i].status = r.status(); reqs[i].resp = (await r.text()).slice(0, 1500); } catch {} } });
const mgr = await page.$("#MiscDescription\\#289_INPUT");
if (mgr) { await mgr.click({ clickCount: 3 }); await mgr.type("TEST MANAGER - APAISuite probe", { delay: 20 }); await page.keyboard.press("Tab"); await sleep(1000); }
const saved = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => /^save$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
console.log("Save clicked:", saved); await sleep(10000);
console.log("after save text:", (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(200, 600));
for (const r of reqs.filter(r => r.m === "POST" || r.m === "PUT")) console.log("POST", r.u.slice(0, 120), r.status, JSON.stringify(r.headers), "\n  BODY:", r.body.slice(0, 1500), "\n  RESP:", (r.resp || "").slice(0, 400));
writeFileSync(`${OUT}/evidence-save-xhr.json`, JSON.stringify(reqs, null, 1));
// Attachments page
reqs.length = 0;
const att = await page.evaluate(() => { const c = [...document.querySelectorAll("a, li, span, button")].filter(x => x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().width < 400).find(x => /^attachments$/i.test((x.innerText || "").trim())); if (c) { c.click(); return true; } return false; });
console.log("Attachments click:", att); await sleep(8000);
console.log("ATT URL:", page.url());
console.log("ATT TEXT:", (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(200, 1800));
console.log("ATT XHR:", JSON.stringify([...new Set(reqs.map(r => r.m + " " + r.u.split("?")[0] + (r.u.includes("attachedEntity") ? " ?" + r.u.split("?")[1].slice(0, 120) : "")))], null, 1));
await page.screenshot({ path: `${OUT}/claim-attachments.png`, fullPage: true });
// Supplemental Information page
reqs.length = 0;
const sup = await page.evaluate(() => { const c = [...document.querySelectorAll("a, li, span, button")].filter(x => x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().width < 400).find(x => /^supplemental information$/i.test((x.innerText || "").trim())); if (c) { c.click(); return true; } return false; });
console.log("Supplemental click:", sup); await sleep(8000);
console.log("SUP URL:", page.url());
console.log("SUP TEXT:", (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(200, 2200));
console.log("SUP XHR:", JSON.stringify([...new Set(reqs.map(r => r.m + " " + r.u.split("?")[0]))], null, 1));
await page.screenshot({ path: `${OUT}/claim-supplemental.png`, fullPage: true });
await browser.disconnect();
