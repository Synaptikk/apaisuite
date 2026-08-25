// dev/run-dev-extension.mjs
//
// Load the dev build into the debug Edge profile and drive it over CDP:
// open the suite, switch to a module, capture the page + service-worker
// consoles, optionally click something, screenshot the result.
//
//   node dev/run-dev-extension.mjs                       # open digitalmetrics
//   node dev/run-dev-extension.mjs --module=vizpick
//   node dev/run-dev-extension.mjs --click="Sync now" --wait=180
//   node dev/run-dev-extension.mjs --restart            # relaunch Edge first
//
// Why --restart matters: an unpacked extension's module graph is cached per
// extension id, and the id is derived from the load path. Re-running
// dev-build.sh writes the same path, so Edge keeps the OLD service worker
// until the extension is reloaded. This script reloads it explicitly through
// chrome.runtime.reload() before driving, so SW changes actually take effect.
//
// Requires: ./dev/dev-build.sh (creates the build), and Edge reachable on the
// CDP port — this script will start it with --load-extension if needed.

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.EDGE_CDP_PORT || "9222";
const BROWSER_URL = `http://localhost:${PORT}`;
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const MODULE  = arg("module", "digitalmetrics");
const CLICK   = arg("click");
const WAIT_S  = Number(arg("wait", "25"));
const RESTART = process.argv.includes("--restart");

const BUILD = arg("build",
  join(homedir(), "Desktop", "APAISuite-dev", "unified-extension-suite"));
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const SHOT = resolve(HERE, "screenshots", `dev-${MODULE}.png`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(BUILD)) {
  console.error(`✗ dev build not found at ${BUILD}\n  Run ./dev/dev-build.sh first.`);
  process.exit(1);
}

function edgeExe() {
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]) if (existsSync(p)) return p;
  return null;
}

async function alive() {
  try { const r = await fetch(`${BROWSER_URL}/json/version`); return r.ok; } catch { return false; }
}

async function launch() {
  const exe = edgeExe();
  if (!exe) { console.error("✗ msedge.exe not found"); process.exit(1); }
  console.log("→ launching Edge with the dev extension loaded ...");
  spawn(exe, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${BUILD}`,
    "--no-first-run", "--no-default-browser-check",
  ], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await alive()) return true; }
  return false;
}

// A browser already up WITHOUT --load-extension cannot be given the extension
// after the fact, so a restart is the only way in.
if (RESTART && await alive()) {
  console.log("→ closing the existing debug browser ...");
  const b = await puppeteer.connect({ browserURL: BROWSER_URL }).catch(() => null);
  if (b) { await b.close().catch(() => {}); }
  await sleep(3000);
}
if (!(await alive())) {
  if (!(await launch())) { console.error(`✗ nothing answering on ${BROWSER_URL}`); process.exit(1); }
}

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log("✓ attached");

// ── find the extension ────────────────────────────────────────────────────
const targets = await browser.targets();
const swTarget = targets.find((t) => t.url().startsWith("chrome-extension://") &&
                                     /service_worker/.test(t.url()));
const anyExt = targets.find((t) => t.url().startsWith("chrome-extension://"));
const extUrl = swTarget?.url() || anyExt?.url();
if (!extUrl) {
  console.error("✗ no chrome-extension:// target found.");
  console.error("  The extension is probably not loaded — re-run with --restart.");
  console.error("  Targets seen:");
  for (const t of targets) console.error(`    ${t.type()}  ${t.url().slice(0, 100)}`);
  process.exit(1);
}
const EXT_ID = extUrl.split("/")[2];
console.log(`✓ extension id: ${EXT_ID}`);

// ── force the service worker to pick up new code ──────────────────────────
console.log("→ reloading the extension so SW changes take effect ...");
{
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/app.html`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => { try { chrome.runtime.reload(); } catch {} }).catch(() => {});
  await page.close().catch(() => {});
  await sleep(4000);
}

// ── collect the service-worker console ────────────────────────────────────
const swLogs = [];
const attachSw = async () => {
  const t = (await browser.targets()).find((t) => t.url().startsWith(`chrome-extension://${EXT_ID}`) &&
                                                  /service_worker/.test(t.url()));
  if (!t) return false;
  const w = await t.worker().catch(() => null);
  if (!w) return false;
  w.on("console", (m) => swLogs.push(`[sw:${m.type()}] ${m.text()}`));
  return true;
};
for (let i = 0; i < 10 && !(await attachSw()); i++) await sleep(1000);

// ── open the suite ────────────────────────────────────────────────────────
const page = await browser.newPage();
const pageLogs = [];
page.on("console", (m) => pageLogs.push(`[page:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => pageLogs.push(`[page:error] ${e.message}`));

await page.goto(`chrome-extension://${EXT_ID}/app.html#${MODULE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(4000);

// Route via the sidebar when the hash alone did not land us there.
const landed = await page.evaluate((mod) => document.querySelector(`.module-${mod}`) != null, MODULE);
if (!landed) {
  await page.evaluate((mod) => {
    const btn = [...document.querySelectorAll("button, a, [role=button]")]
      .find((b) => (b.getAttribute("data-module") || b.textContent || "").toLowerCase().includes(mod));
    btn?.click();
  }, MODULE);
  await sleep(3500);
}

console.log(`\n→ module mounted: ${await page.evaluate((m) => !!document.querySelector(`.module-${m}`), MODULE)}`);

if (CLICK) {
  console.log(`→ clicking ${JSON.stringify(CLICK)} and waiting up to ${WAIT_S}s ...`);
  const clicked = await page.evaluate((label) => {
    const el = [...document.querySelectorAll("button, [role=button], label")]
      .find((b) => (b.textContent || "").trim().toLowerCase() === label.toLowerCase());
    if (!el) return false;
    el.click();
    return true;
  }, CLICK);
  if (!clicked) console.log(`   ✗ no control labelled ${JSON.stringify(CLICK)}`);
  else {
    const deadline = Date.now() + WAIT_S * 1000;
    while (Date.now() < deadline) {
      const status = await page.evaluate(() =>
        document.querySelector("#dm-pull-status")?.textContent || "").catch(() => "");
      if (status && !/sync(ing)?…/i.test(status)) { console.log(`   status: ${status}`); break; }
      await sleep(2000);
    }
  }
}

await page.screenshot({ path: SHOT, fullPage: false }).catch(() => {});

const dump = (title, lines) => {
  console.log(`\n─── ${title} (${lines.length}) ───`);
  for (const l of lines.slice(-40)) console.log("  " + l.slice(0, 300));
};
dump("service worker console", swLogs);
dump("page console", pageLogs);

console.log(`\n✓ screenshot: ${SHOT}`);
await browser.disconnect();
