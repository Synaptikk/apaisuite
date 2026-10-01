// Exercise the Settings token field exactly as a paste would: open Settings,
// put text in the input, fire `change`, and confirm it reached the SW, that the
// field was blanked, and that the status line updated.
import puppeteer from "puppeteer-core";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const tok = /^puppy_token\s*=\s*(.+)$/m
  .exec(fs.readFileSync(path.join(os.homedir(), ".code_puppy", "puppy.cfg"), "utf8"))?.[1]?.trim();
if (!tok) { console.log("no token on this machine"); process.exit(1); }

const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

console.log("before:", JSON.stringify(await page.evaluate(() => new Promise((res) =>
  chrome.runtime.sendMessage({ module: "cx", type: "tokenInfo" }, res)))));

// Open Settings the way a user would, then drive the field.
await page.click("[data-action='open-settings']");
await new Promise(r => setTimeout(r, 500));

const ui = await page.evaluate((t) => {
  const panel = document.querySelector("[data-settings-panel]");
  const input = document.querySelector("[data-setting-token]");
  if (!input) return { err: "no token input" };
  input.value = t;                                   // what a paste leaves behind
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { panelVisible: !panel.hidden, inputType: input.type };
}, tok);
console.log("ui:", JSON.stringify(ui));
await new Promise(r => setTimeout(r, 1500));

console.log("after :", JSON.stringify(await page.evaluate(() => new Promise((res) =>
  chrome.runtime.sendMessage({ module: "cx", type: "tokenInfo" }, res)))));
console.log("field/status:", JSON.stringify(await page.evaluate(() => ({
  fieldCleared: document.querySelector("[data-setting-token]")?.value === "",
  status: document.querySelector("[data-token-status]")?.textContent?.trim(),
  statusClass: document.querySelector("[data-token-status]")?.className,
  narrativeNote: document.querySelector("[data-narrative-body]")?.textContent?.replace(/\s+/g," ").trim().slice(0, 90),
}))));

// Leave it as we found it unless asked to keep it.
if (process.env.KEEP_TOKEN !== "1") {
  await page.evaluate(() => new Promise((res) => chrome.runtime.sendMessage(
    { module: "cx", type: "setSettings", patch: { gatewayToken: "" } }, res)));
  console.log("cleared again (KEEP_TOKEN=1 to leave it set)");
}
await browser.disconnect();
