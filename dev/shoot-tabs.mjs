// dev/shoot-tabs.mjs
//
// Screenshot named DigitalMetrics tabs from an already-running debug browser.
//
//   node dev/shoot-tabs.mjs --build=<dir> --tabs=insights,leaderboard,assignments
//
// Resolves the extension id by LOAD PATH, not by grabbing the first
// chrome-extension target — the debug profile keeps an entry for every build
// ever loaded, and orphans from deleted directories come back first.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const TABS = (arg("tabs", "insights,leaderboard,assignments") || "").split(",").filter(Boolean);
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
  const t = (await browser.targets()).find((t) => t.url().startsWith("chrome-extension://"));
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

for (const t of TABS) {
  await page.evaluate((x) => document.querySelector(`.dm-tab[data-dm-page="${x}"]`)?.click(), t);
  await sleep(2500);
  const out = resolve(HERE, "screenshots", `tab-${t}.png`);
  await page.screenshot({ path: out });
  console.log("shot", t, "→", out);
}

await page.close();
browser.disconnect();
