// dev/exc-classify-check.mjs
//
// Verify that assigning the EXC task on the Assignments grid reclassifies the
// associate as Exceptions — the mechanism that replaced the Classify tab.
//
//   node dev/exc-classify-check.mjs --build=<dir>
//
// Writes to the live database: it sets a task on a real associate and then
// clears it again, restoring the original classification.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = null;
if (BUILD) {
  const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", "Secure Preferences"), "utf8"));
  const want = BUILD.replace(/[\\/]+/g, "\\").toLowerCase();
  for (const [k, v] of Object.entries(prefs?.extensions?.settings || {})) {
    if (String(v?.path || "").replace(/[\\/]+/g, "\\").toLowerCase() === want) id = k;
  }
}

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
if (!id) {
  const t = (await browser.targets()).find((x) => x.url().startsWith("chrome-extension://"));
  id = t ? new URL(t.url()).host : null;
}
if (!id) { console.error("✗ no extension id"); process.exit(1); }

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1050 });
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3000);
await page.evaluate(() => {
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => /digital metrics/i.test((e.textContent || "").trim()))?.click();
});
await page.waitForFunction(
  () => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 },
).catch(() => {});
await sleep(2500);
await page.evaluate(() => document.querySelector('.dm-tab[data-dm-page="assignments"]')?.click());
await sleep(3000);

const ask = (type, payload = {}) => page.evaluate((t, pl) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: t, ...pl },
    (r) => res(chrome.runtime.lastError ? { e: chrome.runtime.lastError.message } : r));
}), type, payload);

// Diff the whole map rather than trying to read the name out of the row —
// which cell belongs to whom is a DOM detail, and the classification change is
// what actually matters.
const beforeMap = (await ask("get_classifications"))?.data || {};
const target = await page.evaluate(() => {
  const row = document.querySelector(".dm-cell")?.closest("tr");
  return (row?.innerText || "").split("\n")[0]?.trim() || null;
});
console.log(`target row: ${JSON.stringify(target)}   currently: ${beforeMap[target] ?? "(name not matched)"}`);

// Focus the cell and press the EXC shortcut ("e", per grid.js TASK_SHORTCUTS).
await page.evaluate(() => {
  const c = document.querySelector(".dm-cell");
  c?.focus?.();
  c?.click();
});
await sleep(600);
await page.keyboard.press("e");
await sleep(3000);

const cellText = await page.evaluate(() => document.querySelector(".dm-cell")?.innerText?.trim());
const afterMap = (await ask("get_classifications"))?.data || {};
const changed = Object.keys(afterMap).filter((k) => afterMap[k] !== beforeMap[k])
  .map((k) => `${k}: ${beforeMap[k] ?? "(none)"} -> ${afterMap[k]}`);
console.log(`cell: ${JSON.stringify(cellText)}`);
console.log(changed.length ? `changed: ${changed.join(", ")}` : "changed: (nothing)");
console.log(changed.some((c) => /-> Exceptions$/.test(c))
  ? "✓ EXC set the Exceptions classification"
  : "✗ classification did not change");

// Put it back.
await page.evaluate(() => {
  const c = document.querySelector(".dm-cell");
  c?.focus?.(); c?.click();
});
await sleep(400);
await page.keyboard.press("x");
await sleep(2500);
const restoredMap = (await ask("get_classifications"))?.data || {};
const stillOff = Object.keys(restoredMap).filter((k) => restoredMap[k] !== beforeMap[k]);
console.log(stillOff.length
  ? `✗ not restored: ${stillOff.map((k) => `${k}=${restoredMap[k]}`).join(", ")}`
  : "✓ clearing EXC restored the original classification");

await page.close();
browser.disconnect();
