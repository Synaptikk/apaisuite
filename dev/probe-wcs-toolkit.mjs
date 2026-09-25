import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const tk = (await browser.pages()).find(x => x.url().includes("walmart-claims-services-toolkit"));
if (tk) {
  const pdfs = await tk.evaluate(() => [...document.querySelectorAll("a")].map(a => ({ t: (a.innerText||"").trim().replace(/\s+/g," ").slice(0,90), h: a.href })).filter(l => /\.pdf(\?|$)/i.test(l.h)));
  console.log("TOOLKIT PDFS:", JSON.stringify([...new Map(pdfs.map(p => [p.h, p])).values()], null, 1));
}
const page = await browser.newPage();
const guides = {
  associate: "https://one.walmart.com/content/learn/enterprise-safety/responding-to-an-accident/incident-intake-guide-training/enter-associate-incident.html",
  customer:  "https://one.walmart.com/content/learn/enterprise-safety/responding-to-an-accident/incident-intake-guide-training/enter-customer-incident.html",
  evidence:  "https://one.walmart.com/content/learn/enterprise-safety/responding-to-an-accident/incident-intake-guide-training/evidence-collection-sheet.html",
};
for (const [k, u] of Object.entries(guides)) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log(k, "goto:", e.message));
  let text = "";
  for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 2000)); text = await page.evaluate(() => ((document.querySelector("main, article, .content, #content") || document.body || {}).innerText || "")); if (text.length > 1500) break; }
  writeFileSync(`${OUT}/guide-${k}.txt`, text);
  console.log(`=== ${k}: ${page.url().slice(0,100)} len=${text.length}`);
  console.log(text.slice(0, 2500));
}
await page.close();
await browser.disconnect();
