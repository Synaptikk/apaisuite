// dev/pull-smoke.mjs
//
// End-to-end smoke test of the digitalmetrics automated pull, against a real
// signed-in browser.
//
//   node dev/pull-smoke.mjs --build=/c/Users/me/Desktop/APAISuite-dev-b2/unified-extension-suite
//   node dev/pull-smoke.mjs --build=... --only=schedule
//
// ── Why it insists on a FRESH build path ──────────────────────────────────
// An unpacked extension's id is derived from its load path, and Edge caches
// the module graph per id. Rebuilding into the SAME directory and calling
// chrome.runtime.reload() keeps serving the OLD service-worker code — verified
// 2026-08-25, where two consecutive runs returned byte-identical errors from
// code that had already been fixed on disk. Each iteration therefore needs its
// own directory (dev-build.sh takes the target as its first argument).
//
// Relaunches the debug browser with --load-extension so no manual "Load
// unpacked" step is needed.

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = process.env.EDGE_CDP_PORT || "9222";
const URL_ = `http://localhost:${PORT}`;
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const ONLY  = arg("only");                       // "schedule" | "metrics" | null
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BUILD || !existsSync(BUILD)) {
  console.error(`✗ pass --build=<dir>  (got ${BUILD || "nothing"})`);
  process.exit(1);
}

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
if (!EDGE) { console.error("✗ msedge.exe not found"); process.exit(1); }

const alive = async () => { try { return (await fetch(`${URL_}/json/version`)).ok; } catch { return false; } };

if (await alive()) {
  console.log("→ closing the debug browser ...");
  const b = await puppeteer.connect({ browserURL: URL_ }).catch(() => null);
  if (b) await b.close().catch(() => {});
  await sleep(3500);
}

console.log(`→ launching with --load-extension=${BUILD}`);
spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${BUILD}`,
  "--no-first-run", "--no-default-browser-check",
], { detached: true, stdio: "ignore" }).unref();

for (let i = 0; i < 30 && !(await alive()); i++) await sleep(1000);
if (!(await alive())) { console.error("✗ CDP never came up"); process.exit(1); }

const browser = await puppeteer.connect({ browserURL: URL_, defaultViewport: null });

// The extension id is not knowable up front, and a lazy SW gives no target to
// enumerate — so read it from the profile's own page list after opening one.
// Simplest reliable route: ask any page to look at chrome.runtime once we are
// ON an extension page. So: discover via the targets after nudging Edge.
let extId = null;
for (let i = 0; i < 20 && !extId; i++) {
  const t = (await browser.targets()).find((t) => t.url().startsWith("chrome-extension://"));
  if (t) extId = new URL(t.url()).host;
  else await sleep(1000);
}
if (!extId) {
  // No extension page open yet — open the manager, which forces registration.
  const mp = await browser.newPage();
  await mp.goto("edge://extensions/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  extId = await mp.evaluate(() => {
    const out = [];
    const dig = (root, depth = 0) => {
      if (!root || depth > 6) return;
      for (const el of root.querySelectorAll?.("*") || []) {
        if (el.id && /^[a-p]{32}$/.test(el.id)) out.push(el.id);
        if (el.shadowRoot) dig(el.shadowRoot, depth + 1);
      }
    };
    dig(document);
    return out[0] || null;
  }).catch(() => null);
  await mp.close().catch(() => {});
}
if (!extId) { console.error("✗ could not determine the extension id"); process.exit(1); }
console.log(`✓ extension id: ${extId}`);

const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
await page.goto(`chrome-extension://${extId}/app.html#/digitalmetrics`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(5000);

const ask = (type, payload = {}) => page.evaluate((t, pl) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: t, ...pl }, (r) => {
    res(chrome.runtime.lastError ? { transportError: chrome.runtime.lastError.message } : r);
  });
}), type, payload);

const type = ONLY === "schedule" ? "pull_schedule_now"
           : ONLY === "metrics"  ? "pull_store"
           : "pull_now";
const payload = ONLY === "metrics" ? { store: arg("store", "1458"), force: true } : {};

console.log(`→ ${type} ${JSON.stringify(payload)} ...`);
const t0 = Date.now();
const raw = await ask(type, payload);
const d = raw?.data ?? raw;
console.log(`   (${Math.round((Date.now() - t0) / 1000)}s)\n`);

if (raw?.ok === false) console.log("HANDLER ERROR:", raw.error);
if (raw?.transportError) console.log("TRANSPORT ERROR:", raw.transportError);

if (d?.stores)   console.log("stores  :", JSON.stringify(d.stores));
for (const m of d?.metrics || []) console.log("metrics :", JSON.stringify(m).slice(0, 300));
if (d?.schedule) console.log("schedule:", JSON.stringify(d.schedule).slice(0, 600));
if (d && ONLY)   console.log("result  :", JSON.stringify(d).slice(0, 600));
if (d?.errors?.length) {
  console.log("errors  :");
  for (const e of d.errors) console.log(`   - ${e.scope} → ${String(e.error).slice(0, 260)}`);
} else if (!ONLY && d) {
  console.log("errors  : none");
}

const noisy = logs.filter((l) => /digitalmetrics|error/i.test(l)).slice(-10);
if (noisy.length) { console.log("\npage console:"); noisy.forEach((l) => console.log("   " + l.slice(0, 200))); }

await browser.disconnect();
