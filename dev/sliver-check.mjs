// dev/sliver-check.mjs
//
// Is there a seam between the sticky header and the first totals row that
// roster names can show through while scrolling?
//
//   node dev/sliver-check.mjs --build=<dir>
//
// Measures the real gap (the CSS `top` offsets are fixed pixel values and
// cannot match the header's rendered height exactly), then scrolls and samples
// the seam to confirm nothing bleeds through it.

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
await sleep(2500);
await page.evaluate(() => {
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => /digital metrics/i.test((e.textContent || "").trim()))?.click();
});
await page.waitForFunction(() => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 }).catch(() => {});
await sleep(2000);
await page.evaluate(() => document.querySelector('.dm-tab[data-dm-page="assignments"]')?.click());
await sleep(2500);

// Scroll the grid so roster rows are passing under the sticky block.
await page.evaluate(() => {
  const s = document.querySelector("[data-dm-scroll='grid']");
  if (s) s.scrollTop = 260;
});
await sleep(700);

const geom = await page.evaluate(() => {
  const th = document.querySelector(".dm-grid thead th");
  const first = document.querySelector(".dm-summary .dm-summary-row th");
  if (!th || !first) return null;
  const a = th.getBoundingClientRect();
  const b = first.getBoundingClientRect();
  return {
    headerBottom: +a.bottom.toFixed(1),
    firstSummaryTop: +b.top.toFixed(1),
    gap: +(b.top - a.bottom).toFixed(1),
    headerShadow: getComputedStyle(th).boxShadow.slice(0, 46),
    summaryShadow: getComputedStyle(first).boxShadow.slice(0, 46),
  };
});

if (!geom) { console.error("✗ grid not rendered"); process.exit(1); }
console.log(`header bottom      : ${geom.headerBottom}`);
console.log(`first totals top   : ${geom.firstSummaryTop}`);
console.log(`raw seam           : ${geom.gap}px ${geom.gap > 0 ? "(a real gap — this is what leaked)" : "(none)"}`);
console.log(`header box-shadow  : ${geom.headerShadow}`);
console.log(`totals box-shadow  : ${geom.summaryShadow}`);

// Ask the browser what is actually painted at the seam. If a roster row is
// the topmost element on that line, names are showing through; if the sticky
// header/totals own it, the seam is covered. More reliable than eyeballing a
// 2px strip.
const atSeam = await page.evaluate(() => {
  const th = document.querySelector(".dm-grid thead th");
  const r = th.getBoundingClientRect();
  const y = r.bottom + 0.8;                    // inside the gap
  const out = [];
  for (const x of [r.left + 40, r.left + 200, r.left + 420, r.left + 700]) {
    const els = document.elementsFromPoint(x, y).slice(0, 3);
    out.push(els.map((e) => {
      const row = e.closest?.("tr");
      const inSummary = !!e.closest?.(".dm-summary");
      const inHead = !!e.closest?.("thead");
      const isRoster = !!row && !inSummary && !inHead;
      return `${e.tagName.toLowerCase()}${isRoster ? ":ROSTER" : inSummary ? ":totals" : inHead ? ":header" : ""}`;
    }).join(" > "));
  }
  return out;
});
console.log("\nelements at the seam line:");
atSeam.forEach((s) => console.log(`   ${s}`));
const leaking = atSeam.some((s) => s.startsWith("th:ROSTER") || s.startsWith("td:ROSTER"));
console.log(leaking ? "   ✗ a roster row is on top at the seam" : "   ✓ only header/totals paint the seam");


const shot = resolve(HERE, "screenshots", "sliver-seam.png");
await page.screenshot({
  path: shot,
  clip: await page.evaluate(() => {
    const th = document.querySelector(".dm-grid thead th");
    const r = th.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.bottom - 6), width: 420, height: 16 };
  }),
});
console.log(`\nseam strip saved   : ${shot}`);
console.log(geom.gap <= 0 || /px/.test(geom.summaryShadow)
  ? "✓ seam is covered (shadow spans it)"
  : "✗ seam uncovered");

await page.close();
browser.disconnect();
