// Market scoreboard + PDF export, through the real extension.
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });

console.log("clicking 'Read the market' …");
const t0 = Date.now();
await page.click("[data-action='pull-market']");
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const done = await page.evaluate(() => !!document.querySelector(".cx-market-table"));
  if (done) break;
}
console.log(`market rendered in ${Math.round((Date.now()-t0)/1000)}s`);

const table = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".cx-market-table tbody tr")].map(tr =>
    [...tr.querySelectorAll("td")].map(td => td.textContent.trim().replace(/\s+/g, " ")));
  return {
    lead: document.querySelector(".cx-market-lead")?.textContent?.replace(/\s+/g, " ").trim(),
    sub: document.querySelector("[data-market-sub]")?.textContent?.trim(),
    headers: [...document.querySelectorAll(".cx-market-table thead th")].map(th => th.textContent.trim()),
    rows,
  };
});
console.log("\nsub :", table.sub);
console.log("lead:", table.lead);
console.log("\n" + table.headers.join(" | "));
for (const r of table.rows) console.log("  " + r.join(" | "));

// Mover pills — check the new wording renders.
console.log("\nmovers:", JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll(".cx-mover")].slice(0, 4).map(el => ({
    dir: el.querySelector(".cx-mover-dir")?.textContent?.replace(/\s+/g, " ").trim(),
    name: el.querySelector(".cx-mover-name")?.textContent?.trim(),
  })))));

// PDF
console.log("\nclicking Export PDF …");
const client = await page.createCDPSession();
await client.send("Browser.setDownloadBehavior", {
  behavior: "allow", downloadPath: process.env.DL || ".", eventsEnabled: true,
});
await page.click("[data-action='export-pdf']");
await new Promise(r => setTimeout(r, 12000));
console.log("pdf button state:", await page.evaluate(() => document.querySelector("[data-action='export-pdf']")?.textContent?.trim()));
console.log("toast:", await page.evaluate(() => document.querySelector(".apai-toast, [class*=toast]")?.textContent?.trim() ?? "(none visible)"));

await page.screenshot({ path: process.env.SHOT || "cx-market.png", fullPage: false });
console.log("\nERRORS:", errors.length ? errors : "none");
await browser.disconnect();
