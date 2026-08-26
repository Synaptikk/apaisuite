// dev/clear-test-cells.mjs
//
// Clear task cells left behind by the grid checks in this folder. Those
// scripts write to the LIVE database, so anything they set has to come back
// out — a stray PICK on a real associate's real day is bad data, not a test
// artefact.
//
//   node dev/clear-test-cells.mjs --build=<dir> [--date=YYYY-MM-DD]
//
// Only clears cells that hold an actual task. Suggestions are rendered in the
// same cells but are not assignments, so they are left alone.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const DATE = arg("date");
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = null;
if (BUILD) {
  try {
    const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", "Secure Preferences"), "utf8"));
    const want = BUILD.replace(/[\\/]+/g, "\\").toLowerCase();
    for (const [k, v] of Object.entries(prefs?.extensions?.settings || {})) {
      if (String(v?.path || "").replace(/[\\/]+/g, "\\").toLowerCase() === want) id = k;
    }
  } catch {}
}

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
async function loads(c) {
  const p = await browser.newPage();
  try { await p.goto(`chrome-extension://${c}/app.html`, { waitUntil: "domcontentloaded", timeout: 12_000 }); return true; }
  catch { return false; } finally { await p.close().catch(() => {}); }
}
if (id && !(await loads(id))) id = null;
if (!id) {
  for (const t of await browser.targets()) {
    if (!t.url().startsWith("chrome-extension://")) continue;
    const c = new URL(t.url()).host;
    if (await loads(c)) { id = c; break; }
  }
}
if (!id) { console.error("✗ no loadable extension"); process.exit(1); }

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3000);
await page.evaluate(() => {
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => /digital metrics/i.test((e.textContent || "").trim()))?.click();
});
await page.waitForFunction(() => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 }).catch(() => {});
await sleep(2500);
await page.evaluate(() => document.querySelector('.dm-tab[data-dm-page="assignments"]')?.click());
await sleep(3000);

if (DATE) {
  await page.evaluate((d) => {
    const el = document.querySelector("#dm-asg-date");
    if (!el) return;
    el.value = d;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, DATE);
  await sleep(3000);
}

const filled = () => page.evaluate(() =>
  [...document.querySelectorAll(".dm-cell")]
    .filter((c) => c.innerText.trim() && !c.querySelector(".dm-suggestion-hint"))
    .map((c) => ({ row: c.dataset.dmRow, slot: c.dataset.dmSlot, task: c.innerText.trim() })));

const before = await filled();
console.log(`date: ${await page.evaluate(() => document.querySelector("#dm-asg-date")?.value)}`);
console.log(`assigned cells: ${before.length}`);
for (const f of before) console.log(`   ${f.row} @ slot ${f.slot} = ${f.task}`);

for (const f of before) {
  await page.evaluate((r, s) => {
    const c = document.querySelector(`.dm-cell[data-dm-row="${CSS.escape(r)}"][data-dm-slot="${s}"]`);
    c?.focus({ preventScroll: true });
    c?.click();
  }, f.row, f.slot);
  await sleep(400);
  await page.keyboard.press("x");
  await sleep(1200);
}

// Autosave is debounced; give it time to flush before closing the page.
await sleep(4000);
console.log(`remaining: ${(await filled()).length}`);

await page.close();
browser.disconnect();
