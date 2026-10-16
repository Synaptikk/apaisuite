// dev/dd-shot.mjs — screenshot the Digital Dashboard in the debug Edge (port 9222).
//   SHOT=out.png WIDTH=1500 node dev/dd-shot.mjs
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.setViewport({ width: Number(process.env.WIDTH || 1500), height: 1000 });
await page.goto(`${APP}#/digitaldashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".module-digitaldashboard .dd", { timeout: 30000 });
await new Promise((r) => setTimeout(r, Number(process.env.WAIT || 9000)));
await page.screenshot({ path: process.env.SHOT || "dd.png", fullPage: true });
const check = await page.evaluate(() => ({
  status: document.querySelector("[data-status]")?.textContent,
  asof: document.querySelector("[data-asof]")?.textContent,
  tiles: [...document.querySelectorAll(".dd-tile-value")].map((e) => e.textContent),
  verdict: document.querySelector("[data-staff-verdict]")?.textContent,
  staffRows: document.querySelectorAll("[data-staffing] tbody tr").length,
  hourRows: document.querySelectorAll("[data-hours] tbody tr").length,
  chart: !!document.querySelector("[data-chart] svg"),
  styled: getComputedStyle(document.querySelector(".dd-panel")).borderRadius,
}));
console.log(JSON.stringify(check, null, 1));
if (errors.length) console.log("console errors:", errors.slice(0, 5));
if (process.env.KEEP !== "1") await page.close();
await browser.disconnect();
