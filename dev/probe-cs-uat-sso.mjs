import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes("uat.riskonnectclearsight.com")) || await browser.newPage();
for (const u of ["https://uat.riskonnectclearsight.com/Enterprise/default.cmdx?ssoclient=W100", "https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/?_relay=/Enterprise/default.cmdx?ssoclient=W100"]) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log("goto:", e.message));
  for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 3000)); const cur = page.url(); console.log(`t+${(i+1)*3}s`, cur.slice(0, 180)); if (cur.includes("/app/Clearsight/#")) break; }
  const body = (await page.evaluate(() => document.body.innerText || "")).slice(0, 500);
  console.log("BODY:", body.replace(/\n+/g, " | "));
  if (page.url().includes("/app/Clearsight/#") || !/Client ID/.test(body)) break;
}
await browser.disconnect();
