// dev/tab-smoke.mjs
//
// Click every DigitalMetrics tab in a loaded build and report what each one
// actually renders — content length, whether it fell back to the shell's
// "not yet ported" placeholder, and any error it threw.
//
//   node dev/tab-smoke.mjs --build=<dir>
//   node dev/tab-smoke.mjs            # reuse the browser already running
//
// The module has nine tabs and the port was never exercised in a browser (its
// README says so), so "does it render" is a genuinely open question per tab.

import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.EDGE_CDP_PORT || "9222";
const URL_ = `http://localhost:${PORT}`;
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => { try { return (await fetch(`${URL_}/json/version`)).ok; } catch { return false; } };

if (BUILD) {
  if (!existsSync(BUILD)) { console.error(`✗ no such build: ${BUILD}`); process.exit(1); }
  if (await alive()) {
    const b = await puppeteer.connect({ browserURL: URL_ }).catch(() => null);
    if (b) await b.close().catch(() => {});
    await sleep(3500);
  }
  const EDGE = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
  spawn(EDGE, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    `--load-extension=${BUILD}`, "--no-first-run", "--no-default-browser-check",
  ], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 30 && !(await alive()); i++) await sleep(1000);
}

const browser = await puppeteer.connect({ browserURL: URL_, defaultViewport: null });

// Resolve the id from the profile by matching the LOAD PATH.
//
// Grabbing the first chrome-extension:// target does not work: every build
// ever loaded into this profile leaves an entry behind, and the orphans from
// deleted directories are returned first — producing ERR_FILE_NOT_FOUND on a
// path that no longer exists.
function idForPath(buildPath) {
  try {
    const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", "Secure Preferences"), "utf8"));
    const settings = prefs?.extensions?.settings || {};
    const want = buildPath.replace(/[\\/]+/g, "\\").toLowerCase();
    for (const [id, v] of Object.entries(settings)) {
      const p = String(v?.path || "").replace(/[\\/]+/g, "\\").toLowerCase();
      if (p && p === want) return id;
    }
  } catch {}
  return null;
}

/** Does this id actually serve app.html? The only claim worth trusting. */
async function idLoads(id) {
  const p = await browser.newPage();
  try {
    await p.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    return true;
  } catch { return false; }
  finally { await p.close().catch(() => {}); }
}

// Edge writes Secure Preferences lazily, so immediately after --load-extension
// the file still describes the PREVIOUS build. Retry the path lookup, then
// fall back to probing every chrome-extension target — and in both cases
// verify the id serves a page before committing to it.
let extId = null;
for (let i = 0; i < 10 && !extId; i++) {
  const byPath = BUILD ? idForPath(BUILD) : null;
  if (byPath && await idLoads(byPath)) { extId = byPath; break; }
  await sleep(1000);
}
if (!extId) {
  const seen = new Set();
  for (const t of await browser.targets()) {
    if (!t.url().startsWith("chrome-extension://")) continue;
    const id = new URL(t.url()).host;
    if (seen.has(id)) continue;
    seen.add(id);
    if (await idLoads(id)) { extId = id; break; }
  }
}
if (!extId) { console.error("✗ no loadable extension id"); process.exit(1); }
console.log(`extension: ${extId}`);

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1050 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3500);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => /digital metrics/i.test((e.textContent || "").trim()));
  el?.click();
});
// Wait for the module to finish LOADING, not just mounting. Clicking tabs
// before the store and week resolve makes every page render its "Select a
// store" empty state, which looks identical to a broken tab.
await page.waitForFunction(
  () => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 },
).catch(() => console.log("(warning: week list never populated — reporting empty states)"));
await sleep(2500);

const tabs = await page.evaluate(() =>
  [...document.querySelectorAll(".dm-tab")].map((b) => ({ page: b.dataset.dmPage, label: b.textContent.trim() })));
console.log(`tabs: ${tabs.map((t) => t.page).join(", ")}\n`);

const results = [];
for (const t of tabs) {
  errors.length = 0;
  await page.evaluate((p) => {
    document.querySelector(`.dm-tab[data-dm-page="${p}"]`)?.click();
  }, t.page);
  await sleep(2500);

  const info = await page.evaluate(() => {
    const el = document.querySelector("#dm-page");
    const html = el?.innerHTML || "";
    const text = (el?.innerText || "").trim();
    return {
      chars: html.length,
      textChars: text.length,
      placeholder: /not yet ported/i.test(text),
      empty: text.length < 20,
      firstText: text.slice(0, 90).replace(/\s+/g, " "),
      tables: el?.querySelectorAll("table").length ?? 0,
      rows: el?.querySelectorAll("tbody tr").length ?? 0,
      cards: el?.querySelectorAll(".dm-stat, .dm-card, .card").length ?? 0,
    };
  });

  const verdict = info.placeholder ? "PLACEHOLDER"
                : errors.length     ? "ERROR"
                : info.empty        ? "EMPTY"
                : "ok";
  results.push({ tab: t.page, verdict, ...info, errors: [...errors] });

  console.log(`${verdict.padEnd(12)} ${t.page.padEnd(14)} ${String(info.textChars).padStart(6)} chars` +
              `  tables:${info.tables} rows:${info.rows} cards:${info.cards}`);
  if (info.firstText) console.log(`             ${JSON.stringify(info.firstText)}`);
  for (const e of errors.slice(0, 3)) console.log(`             ✗ ${e.slice(0, 180)}`);
}

const bad = results.filter((r) => r.verdict !== "ok");
console.log(`\n${results.length - bad.length}/${results.length} tabs rendering`);
if (bad.length) console.log(`broken: ${bad.map((b) => `${b.tab}(${b.verdict})`).join(", ")}`);

await page.screenshot({ path: resolve(HERE, "screenshots", "tabs-last.png") }).catch(() => {});
await page.close();
browser.disconnect();
