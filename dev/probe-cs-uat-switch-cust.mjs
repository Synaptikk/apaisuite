// UAT: go back to StartPage, switch the test notice to Customer Incident / Customer Injury or Property Damage, then Next twice.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clickText = async (re, tag = "button, a, li, span") => page.evaluate((src, tag) => { const re = new RegExp(src, "i"); const el = [...document.querySelectorAll(tag)].find(x => re.test((x.innerText || "").trim()) && x.getBoundingClientRect().width > 0); if (el) { el.click(); return (el.innerText || "").trim().slice(0, 40); } return null; }, re.source, tag);
console.log("nav StartPage:", await clickText(/^StartPage$/, "li, a, span, div"));
await sleep(5000);
await page.evaluate(() => document.getElementById("radio-Customer Incident-STARS_454")?.click()); await sleep(2500);
// a confirmation popup may appear ("Changing ... will invalidate ...")
const confirm = await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); if (!m) return null; const t = (m.innerText || "").slice(0, 300); const b = [...m.querySelectorAll("button")].find(b => /^(yes|ok|confirm|continue)$/i.test((b.innerText || "").trim())); b && b.click(); return t; });
console.log("confirm:", confirm); await sleep(2500);
await page.evaluate(() => document.getElementById("radio-Customer Injury or Property Damage-STARS_7")?.click()); await sleep(2000);
await page.evaluate(() => document.getElementById("radio-No-STARS_312")?.click()); await sleep(1000);
await page.evaluate(() => document.getElementById("radio-No-STARS_10")?.click()); await sleep(1000);
const state = await page.evaluate(() => ({ cust: document.getElementById("radio-Customer Incident-STARS_454")?.checked, gl: document.getElementById("radio-Customer Injury or Property Damage-STARS_7")?.checked, tp: document.getElementById("radio-No-STARS_312")?.checked, res: document.getElementById("radio-No-STARS_10")?.checked, visibleRadios: [...document.querySelectorAll("input[type=radio]")].filter(r => r.getBoundingClientRect().width > 0).map(r => r.id) }));
console.log("STATE:", JSON.stringify(state));
console.log("Next 1:", await clickText(/^Next$/)); await sleep(6000);
console.log("page text:", (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(300, 900));
console.log("Next 2:", await clickText(/^Next$/)); await sleep(7000);
const steps = await page.evaluate(() => [...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean));
console.log("STEPS:", JSON.stringify([...new Set(steps)]));
console.log("page text:", (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(300, 1200));
await browser.disconnect();
