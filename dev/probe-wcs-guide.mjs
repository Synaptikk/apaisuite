import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto("https://internal.walmart.com/content/LearningandDevelopment/enterprise-safety/responding-to-an-accident/wcs-incident-intake-user-guide.html", { waitUntil: "domcontentloaded", timeout: 60000 });
let text = "";
for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 2000)); text = await page.evaluate(() => document.body.innerText); if (text.length > 800) break; }
console.log("URL:", page.url());
const links = await page.evaluate(() => [...document.querySelectorAll("a")].map(a => ({ t: a.innerText.trim().slice(0,80), h: a.href })).filter(l => /pdf|guide|intake|form|packet/i.test(l.t + l.h)));
console.log("LINKS:", JSON.stringify(links, null, 1));
writeFileSync("C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad/wcs-guide.txt", text);
console.log("TEXT LEN:", text.length);
console.log(text.slice(0, 6000));
await page.close();
await browser.disconnect();
