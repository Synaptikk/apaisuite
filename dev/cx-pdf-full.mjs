// Generate through the UI exactly as the user would: load token, Write it up,
// then Export PDF — so the cached-read hydration is exercised too.
import puppeteer from "puppeteer-core";
import os from "node:os"; import path from "node:path";
const CFG = path.join(os.homedir(), ".code_puppy", "puppy.cfg");
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const p = await b.newPage();
await p.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 7000));

await p.click("[data-action='open-settings']");
await new Promise(r => setTimeout(r, 600));
await (await p.$("[data-setting-cfg]")).uploadFile(CFG);
await new Promise(r => setTimeout(r, 2000));

await p.click("[data-action='narrate']");
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const done = await p.evaluate(() => /The short version/i.test(document.querySelector("[data-narrative-body]")?.textContent ?? ""));
  if (done) break;
}
console.log("read on screen:", await p.evaluate(() => (document.querySelector("[data-narrative-body]")?.textContent ?? "").slice(0, 60).trim()));

// Remount, to prove the cached read is picked back up.
await p.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 9000));
console.log("after remount  :", await p.evaluate(() => (document.querySelector("[data-narrative-body]")?.textContent ?? "").slice(0, 60).trim()));

await p.click("[data-action='export-pdf']");
await new Promise(r => setTimeout(r, 9000));
await p.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: "signOutGateway" }, r)));
await p.close(); await b.disconnect();
