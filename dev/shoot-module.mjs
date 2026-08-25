// dev/shoot-module.mjs
//
// Relaunch the debug browser on a given build and screenshot a module view.
// Companion to dev/pull-smoke.mjs — same fresh-path requirement, because Edge
// caches an unpacked extension's code per load path.
//
//   node dev/shoot-module.mjs --build=<dir> --module=digitalmetrics --out=after.png

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = `http://localhost:${process.env.EDGE_CDP_PORT || "9222"}`;
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const MODULE = arg("module", "digitalmetrics");
const OUT = resolve(HERE, "screenshots", arg("out", `shot-${MODULE}.png`));
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BUILD || !existsSync(BUILD)) { console.error(`✗ --build=<dir> required (got ${BUILD})`); process.exit(1); }

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);

const alive = async () => { try { return (await fetch(`${URL_}/json/version`)).ok; } catch { return false; } };

if (await alive()) {
  const b = await puppeteer.connect({ browserURL: URL_ }).catch(() => null);
  if (b) await b.close().catch(() => {});
  await sleep(3500);
}
spawn(EDGE, [
  `--remote-debugging-port=${process.env.EDGE_CDP_PORT || "9222"}`,
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${BUILD}`,
  "--no-first-run", "--no-default-browser-check",
], { detached: true, stdio: "ignore" }).unref();

for (let i = 0; i < 30 && !(await alive()); i++) await sleep(1000);
const browser = await puppeteer.connect({ browserURL: URL_, defaultViewport: null });

let id = null;
for (let i = 0; i < 15 && !id; i++) {
  const t = (await browser.targets()).find((t) => t.url().startsWith("chrome-extension://"));
  if (t) id = new URL(t.url()).host; else await sleep(1000);
}
if (!id) {
  const mp = await browser.newPage();
  await mp.goto("edge://extensions/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  id = await mp.evaluate(() => {
    const out = [];
    const dig = (root, d = 0) => {
      if (!root || d > 6) return;
      for (const el of root.querySelectorAll?.("*") || []) {
        if (el.id && /^[a-p]{32}$/.test(el.id)) out.push(el.id);
        if (el.shadowRoot) dig(el.shadowRoot, d + 1);
      }
    };
    dig(document);
    return out[0] || null;
  }).catch(() => null);
  await mp.close().catch(() => {});
}
if (!id) { console.error("✗ no extension id"); process.exit(1); }

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1050 });
await page.goto(`chrome-extension://${id}/app.html#/${MODULE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(6000);
await page.screenshot({ path: OUT });

const sheets = await page.evaluate(() =>
  [...document.styleSheets].map((s) => (s.href || "(inline)").split("/").slice(-2).join("/")));
console.log("stylesheets:", JSON.stringify(sheets));
console.log("screenshot :", OUT);

await page.close();
browser.disconnect();
