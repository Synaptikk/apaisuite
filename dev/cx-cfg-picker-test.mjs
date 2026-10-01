// Drive the "Load from puppy.cfg" picker with the REAL file and confirm the
// token lands, without ever printing it.
import puppeteer from "puppeteer-core";
import os from "node:os";
import path from "node:path";
const CFG = path.join(os.homedir(), ".code_puppy", "puppy.cfg");
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 150000 });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));

const info = (t) => page.evaluate((t) => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: t }, r)), t);
// Start clean so the result is unambiguous.
await page.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: "signOutGateway" }, r)));
console.log("before:", JSON.stringify((await info("tokenInfo")).status));

await page.click("[data-action='open-settings']");
await new Promise(r => setTimeout(r, 600));

const input = await page.$("[data-setting-cfg]");
if (!input) { console.log("FAIL: no file input rendered"); }
else {
  await input.uploadFile(CFG);
  await new Promise(r => setTimeout(r, 2500));
  const after = (await info("tokenInfo")).status;
  console.log("after :", JSON.stringify(after));
  console.log("status line:", await page.evaluate(() => document.querySelector("[data-token-status]")?.textContent?.trim()));
  console.log("sign-in label:", await page.evaluate(() => document.querySelector("[data-action='signin-gateway']")?.textContent?.trim()));
  console.log("sign-out shown:", await page.evaluate(() => !document.querySelector("[data-action='signout-gateway']")?.hidden));
  console.log("narrative note:", await page.evaluate(() => document.querySelector("[data-narrative-body]")?.textContent?.replace(/\s+/g," ").trim().slice(0, 70)));
}
console.log("page errors:", errs.length ? errs : "none");

// Leave the device as we found it.
if (process.env.KEEP_TOKEN !== "1") {
  await page.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: "signOutGateway" }, r)));
  console.log("(token cleared again; KEEP_TOKEN=1 to leave it)");
}
await page.close();
await browser.disconnect();
