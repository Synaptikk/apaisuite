import puppeteer from "puppeteer-core";
const URL = "https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/#/intake/stars.intakenotice";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.bringToFront();
await new Promise(r => setTimeout(r, 5000));
console.log("URL:", page.url(), "TITLE:", await page.title());
const links = await page.evaluate(() => [...document.querySelectorAll("a")].map(a => ({ t: (a.innerText||"").trim().slice(0,60), h: a.href })).filter(l => l.t));
console.log("LINKS:", JSON.stringify(links.slice(0, 15)));
const sso = await page.evaluateHandle(() => [...document.querySelectorAll("a")].find(a => /single sign on/i.test(a.innerText||"")));
if (sso && await sso.asElement()) {
  await Promise.all([ page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log("nav:", e.message)), sso.asElement().click() ]);
  for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 3000)); const u = page.url(); console.log(`t+${(i+1)*3}s`, u.slice(0, 160)); if (u.includes("/app/Clearsight")) break; }
}
console.log("FINAL:", page.url(), "TITLE:", await page.title());
console.log("BODY:", (await page.evaluate(() => document.body.innerText || "")).slice(0, 1200));
await browser.disconnect();
