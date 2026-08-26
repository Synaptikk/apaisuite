// dev/grid-select-check.mjs
//
// Reported 2026-08-26: assigning a task scrolls the page, and there is no way
// to select several cells at once.
//
// Checks, against a live build:
//   · the grid's scroll position survives a task assignment
//   · drag across cells selects a rectangle
//   · a task key fills the whole selection
//
//   node dev/grid-select-check.mjs --build=<dir>
//
// Writes to the live database, then clears what it set.

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
await page.setViewport({ width: 1400, height: 800 });
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

// ── 1. scroll stability ──────────────────────────────────────────────────
await page.evaluate(() => {
  const s = document.querySelector("[data-dm-scroll='grid']");
  if (s) { s.scrollTop = 200; s.scrollLeft = 120; }
  window.scrollTo(0, 150);
});
await sleep(600);

const before = await page.evaluate(() => {
  const s = document.querySelector("[data-dm-scroll='grid']");
  return { top: s?.scrollTop, left: s?.scrollLeft, win: window.scrollY };
});

// Assign to a cell that is currently visible in the scrolled viewport.
await page.evaluate(() => {
  const cells = [...document.querySelectorAll(".dm-cell")];
  const s = document.querySelector("[data-dm-scroll='grid']");
  const box = s.getBoundingClientRect();
  const visible = cells.find((c) => {
    const r = c.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom;
  }) || cells[0];
  visible.focus({ preventScroll: true });
});
await sleep(400);
await page.keyboard.press("p");
await sleep(1800);

const after = await page.evaluate(() => {
  const s = document.querySelector("[data-dm-scroll='grid']");
  return { top: s?.scrollTop, left: s?.scrollLeft, win: window.scrollY };
});
console.log("1) scroll before:", JSON.stringify(before));
console.log("   scroll after :", JSON.stringify(after));
const stable = before.top === after.top && before.left === after.left && before.win === after.win;
console.log(stable ? "   ✓ scroll position held" : "   ✗ the view moved");

// ── 2. drag selection ────────────────────────────────────────────────────
await page.evaluate(() => {
  const s = document.querySelector("[data-dm-scroll='grid']");
  if (s) { s.scrollTop = 0; s.scrollLeft = 0; }
});
await sleep(400);

const box = await page.evaluate(() => {
  const cells = [...document.querySelectorAll(".dm-cell")];
  const a = cells[0], b = cells[2];
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  return {
    from: { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 },
    to:   { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 },
  };
});

await page.mouse.move(box.from.x, box.from.y);
await page.mouse.down();
await page.mouse.move(box.to.x, box.to.y, { steps: 8 });
const selectedDuringDrag = await page.evaluate(() =>
  document.querySelectorAll(".dm-cell.is-selected").length);
await page.mouse.up();
await sleep(1200);
const selectedAfter = await page.evaluate(() =>
  document.querySelectorAll(".dm-cell.is-selected").length);

console.log(`\n2) selected during drag: ${selectedDuringDrag}, after release: ${selectedAfter}`);
console.log(selectedDuringDrag >= 3 && selectedAfter >= 3
  ? "   ✓ drag selects a rectangle and it survives the re-render"
  : "   ✗ selection did not take");

// ── 3. one key fills the selection ───────────────────────────────────────
await page.keyboard.press("d");
await sleep(2000);
const filled = await page.evaluate(() =>
  [...document.querySelectorAll(".dm-cell")].slice(0, 4).map((c) => c.innerText.trim()));
console.log(`\n3) first four cells after pressing D: ${JSON.stringify(filled)}`);
console.log(filled.slice(0, 3).every((t) => t === "DISP")
  ? "   ✓ the key filled every selected cell"
  : "   ✗ only some cells were filled");

// ── clean up ─────────────────────────────────────────────────────────────
await page.keyboard.press("x");
await sleep(1500);
await page.evaluate(() => document.querySelector(".dm-cell")?.focus({ preventScroll: true }));
await page.keyboard.press("Escape");
await sleep(500);
for (let i = 0; i < 4; i++) {
  await page.evaluate((n) => {
    const c = document.querySelectorAll(".dm-cell")[n];
    c?.focus({ preventScroll: true }); c?.click();
  }, i);
  await sleep(250);
  await page.keyboard.press("x");
  await sleep(800);
}
console.log("\ncleaned:", JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll(".dm-cell")].slice(0, 4).map((c) => c.innerText.trim()))));

await page.close();
browser.disconnect();
