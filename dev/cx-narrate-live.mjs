// The real thing: load the token from puppy.cfg through the picker, then ask
// for the written read and confirm we get analysis — not the version block.
import puppeteer from "puppeteer-core";
import os from "node:os"; import path from "node:path";
const CFG = path.join(os.homedir(), ".code_puppy", "puppy.cfg");
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));

await page.click("[data-action='open-settings']");
await new Promise(r => setTimeout(r, 600));
await (await page.$("[data-setting-cfg]")).uploadFile(CFG);
await new Promise(r => setTimeout(r, 2000));
console.log("token:", await page.evaluate(() => document.querySelector("[data-token-status]")?.textContent?.trim()));
console.log("version field placeholder:", await page.evaluate(() => document.querySelector("[data-setting-version]")?.placeholder));

const t0 = Date.now();
const res = await page.evaluate(() => new Promise(r =>
  chrome.runtime.sendMessage({ module: "cx", type: "narrate", force: true }, r)));
console.log(`\nnarrate ${Math.round((Date.now()-t0)/1000)}s  ok=${res?.ok} reason=${res?.reason ?? ""}`);
if (!res?.ok) console.log("error:", res?.error);
else {
  const t = res.narrative.text;
  console.log("blocked-text present:", /out of date|temporarily blocked/i.test(t), "(want false)");
  console.log("length:", t.length, "| model:", res.narrative.model);
  console.log("\n" + t.slice(0, 700));
}
await page.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: "signOutGateway" }, r)));
console.log("\n(token cleared from the module again)");
await page.close(); await browser.disconnect();
