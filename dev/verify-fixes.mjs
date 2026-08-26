// dev/verify-fixes.mjs
//
// Check the four defects reported 2026-08-26 against a live build:
//   1. digital team leads classified as Store Help
//   2. nonsense peak hours ("21 PM")
//   3. associate names not clickable on the boards
//   4. scheduled-hour shading too faint
//
//   node dev/verify-fixes.mjs --build=<dir>

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

// Edge writes Secure Preferences lazily, so straight after --load-extension the
// path lookup still describes the previous build. Fall back to probing every
// chrome-extension target, and verify the id actually serves a page — the
// profile keeps entries for builds whose directories are long gone.
async function loads(candidate) {
  const p = await browser.newPage();
  try {
    await p.goto(`chrome-extension://${candidate}/app.html`, { waitUntil: "domcontentloaded", timeout: 12_000 });
    return true;
  } catch { return false; }
  finally { await p.close().catch(() => {}); }
}
if (id && !(await loads(id))) id = null;
if (!id) {
  const seen = new Set();
  for (const t of await browser.targets()) {
    if (!t.url().startsWith("chrome-extension://")) continue;
    const c = new URL(t.url()).host;
    if (seen.has(c)) continue;
    seen.add(c);
    if (await loads(c)) { id = c; break; }
  }
}
if (!id) { console.error("✗ no loadable extension id — open the suite once in the debug browser"); process.exit(1); }

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

const ask = (type, payload = {}) => page.evaluate((t, pl) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: t, ...pl },
    (r) => res(chrome.runtime.lastError ? { e: chrome.runtime.lastError.message } : r));
}), type, payload);

// 1 ── classification
const cls = (await ask("get_classifications"))?.data || {};
const counts = {};
for (const v of Object.values(cls)) counts[v] = (counts[v] || 0) + 1;
console.log("1) classification counts:", JSON.stringify(counts));

const tab = async (name) => {
  await page.evaluate((n) => document.querySelector(`.dm-tab[data-dm-page="${n}"]`)?.click(), name);
  await sleep(2500);
};

// 2 ── peak hours
await tab("insights");
const peaks = await page.evaluate(() =>
  [...document.querySelectorAll("#dm-page .dm-stat")]
    .map((e) => e.innerText.replace(/\s+/g, " ").trim())
    .filter((t) => /Peak Hour/i.test(t)).slice(0, 5));
console.log("2) peak hours:");
for (const p of peaks) console.log("     " + p);
const bad = peaks.filter((p) => /\b(1[3-9]|2\d|3\d) (AM|PM)\b/.test(p));
console.log(bad.length ? `   ✗ still impossible: ${bad.join(" | ")}` : "   ✓ all within a 12-hour clock");

// 3 ── clickable names
await tab("leaderboard");
const clickable = await page.evaluate(() => document.querySelectorAll("#dm-page [data-dm-associate]").length);
console.log(`3) clickable names on leaderboard: ${clickable} ${clickable ? "✓" : "✗"}`);
await page.screenshot({ path: resolve(HERE, "screenshots", "fix-leaderboard.png") });

// does clicking one open the breakdown?
await page.evaluate(() => document.querySelector("#dm-page [data-dm-associate]")?.click());
await sleep(2500);
const opened = await page.evaluate(() => (document.querySelector("#dm-page")?.innerText || "").slice(0, 60).replace(/\s+/g, " "));
console.log(`   after click: ${JSON.stringify(opened)}`);

// 4 ── assignments shading
await tab("assignments");
const shading = await page.evaluate(() => {
  const inShift = document.querySelector("#dm-page .dm-cell.in-shift");
  const off = document.querySelector("#dm-page .dm-cell:not(.in-shift)");
  const g = (el) => el ? {
    bg: getComputedStyle(el).backgroundColor,
    opacity: getComputedStyle(el).opacity,
    shadow: getComputedStyle(el).boxShadow.slice(0, 40),
  } : null;
  return { inShift: g(inShift), off: g(off) };
});
console.log("4) cell shading:", JSON.stringify(shading));
await page.screenshot({ path: resolve(HERE, "screenshots", "fix-assignments.png") });

await page.close();
browser.disconnect();
