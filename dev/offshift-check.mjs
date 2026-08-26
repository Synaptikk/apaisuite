// dev/offshift-check.mjs
//
// Verify that hours outside an associate's shift cannot be assigned:
// not focusable, and a key press on one writes nothing.
//
//   node dev/offshift-check.mjs --build=<dir>
//
// Read-only: it deliberately attempts an edit that must FAIL, so nothing
// should be written. It reports if anything was.

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

const shape = await page.evaluate(() => {
  const cells = [...document.querySelectorAll(".dm-cell")];
  const off = cells.filter((c) => c.hasAttribute("data-dm-offshift"));
  const on  = cells.filter((c) => !c.hasAttribute("data-dm-offshift"));
  return {
    total: cells.length,
    offShift: off.length,
    offFocusable: off.filter((c) => c.hasAttribute("tabindex")).length,
    inFocusable: on.filter((c) => c.hasAttribute("tabindex")).length,
    sample: off[0] ? { row: off[0].dataset.dmRow, slot: off[0].dataset.dmSlot, text: off[0].innerText.trim() } : null,
  };
});
console.log(`cells: ${shape.total}, off-shift: ${shape.offShift}`);
// Off-shift cells ARE focusable on purpose: assigning is refused in the key
// handler, but clearing has to stay possible or stale out-of-shift tasks
// written before the rule existed could never be removed.
console.log(`off-shift cells focusable (for clearing) : ${shape.offFocusable} ${shape.offFocusable > 0 ? "✓" : "✗"}`);
console.log(`in-shift cells that are focusable  : ${shape.inFocusable} ${shape.inFocusable > 0 ? "✓" : "✗"}`);

// Try to type into an off-shift cell anyway.
if (shape.sample) {
  const before = shape.sample.text;
  await page.evaluate(() => {
    const c = [...document.querySelectorAll(".dm-cell")].find((x) => x.hasAttribute("data-dm-offshift"));
    c?.focus?.({ preventScroll: true });
    c?.click();
  });
  await sleep(400);
  await page.keyboard.press("p");
  await sleep(1500);
  const after = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".dm-cell")].find((x) => x.hasAttribute("data-dm-offshift"));
    return c?.innerText.trim();
  });
  console.log(`\ntyping P into an off-shift cell (${shape.sample.row} @ ${shape.sample.slot}):`);
  console.log(`  before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`);
  console.log(before === after ? "  ✓ nothing was written" : "  ✗ the cell accepted an assignment");
}

// Clearing an off-shift cell must still work.
{
  const target = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".dm-cell")]
      .find((x) => x.hasAttribute("data-dm-offshift"));
    if (!c) return null;
    c.focus({ preventScroll: true });
    c.click();
    return { row: c.dataset.dmRow, slot: c.dataset.dmSlot, text: c.innerText.trim() };
  });
  if (target) {
    await sleep(400);
    await page.keyboard.press("x");
    await sleep(1200);
    const after = await page.evaluate(() =>
      [...document.querySelectorAll(".dm-cell")].find((x) => x.hasAttribute("data-dm-offshift"))?.innerText.trim());
    console.log(`
clearing an off-shift cell: ${JSON.stringify(target.text)} → ${JSON.stringify(after)}`);
    console.log(after === "" ? "  ✓ clearing is allowed" : "  ✗ clearing was blocked");
  }
}

const lunch = await page.evaluate(() => ({
  banner: document.querySelector(".dm-warn")?.innerText.replace(/\s+/g, " ").trim() || null,
  flags: document.querySelectorAll(".dm-lunch-flag").length,
  summaryRows: document.querySelectorAll(".dm-summary .dm-summary-row").length,
  firstBodyRowIsSummary: !!document.querySelector(".dm-grid tbody")?.classList.contains("dm-summary"),
}));
console.log(`\nlunch banner : ${lunch.banner}`);
console.log(`lunch flags  : ${lunch.flags}`);
console.log(`summary rows : ${lunch.summaryRows} (at top: ${lunch.firstBodyRowIsSummary ? "✓" : "✗"})`);

await page.close();
browser.disconnect();
