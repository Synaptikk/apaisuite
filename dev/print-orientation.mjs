// dev/print-orientation.mjs
//
// Portrait or landscape for the assignment sheet? Measure both rather than
// pick one, because the grid is lopsided: 18 columns wide but 73 rows tall.
//
//   node dev/print-orientation.mjs --build=<dir>
//
// Landscape gives width the 18 columns do not need (task codes are 1-5
// characters). Portrait gives height, and height is what sets the type size —
// which is what "readable" means here.
//
// Also reports the computed ink colour, since a 5.5pt screenshot shows
// subpixel fringing that looks like coloured text but is not.

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
await page.setViewport({ width: 1400, height: 900 });
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3000);
await page.evaluate(() => {
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => (e.textContent || "").trim().toLowerCase().includes("digital metrics"))?.click();
});
await page.waitForFunction(() => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 }).catch(() => {});
await sleep(2000);
await page.evaluate(() => document.querySelector('.dm-tab[data-dm-page="assignments"]')?.click());
await sleep(3000);
await page.emulateMediaType("print");
await sleep(400);

const ink = await page.evaluate(() => {
  const g = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : null; };
  return { name: g(".dm-name"), cell: g(".dm-cell"), totals: g(".dm-summary .dm-summary-row td") };
});
console.log("computed ink in print media:");
console.log(`  name   : ${ink.name}`);
console.log(`  cell   : ${ink.cell}`);
console.log(`  totals : ${ink.totals}`);
console.log(`  ${Object.values(ink).every((c) => c === "rgb(0, 0, 0)") ? "✓ all black — the colour in the PNG is subpixel fringing" : "✗ something is still tinted"}`);

// Try a range of font sizes in each orientation and find the largest that
// still fits one page.
const USABLE = { landscape: { w: 285, h: 193 }, portrait: { w: 198, h: 280 } };
const PX = 3.7795;

for (const orient of ["landscape", "portrait"]) {
  let best = null;
  for (const pt of [5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 11, 12]) {
    const fits = await page.evaluate((pt, usable, px) => {
      const root = document.querySelector(".module-digitalmetrics");
      root.style.setProperty("--dm-print-probe", "1");
      const grid = document.querySelector(".dm-grid");
      const prevW = grid.style.width, prevF = grid.style.fontSize;
      grid.style.fontSize = pt + "pt";
      grid.style.width = (usable.w * px) + "px";
      const cells = [...document.querySelectorAll(".dm-grid th, .dm-grid td")];
      const prev = cells.map((c) => c.style.fontSize);
      cells.forEach((c) => { c.style.fontSize = pt + "pt"; });
      // force layout
      const h = grid.getBoundingClientRect().height / px;
      const widest = Math.max(...[...document.querySelectorAll(".dm-cell")].map((c) => c.scrollWidth));
      const overflow = [...document.querySelectorAll(".dm-cell")].some((c) => c.scrollWidth > c.clientWidth + 1);
      grid.style.fontSize = prevF; grid.style.width = prevW;
      cells.forEach((c, i) => { c.style.fontSize = prev[i]; });
      return { height: +h.toFixed(1), overflow, widest };
    }, pt, USABLE[orient], PX);

    const ok = fits.height <= USABLE[orient].h - 5 && !fits.overflow;
    if (ok) best = { pt, ...fits };
  }
  console.log(`\n${orient} (usable ${USABLE[orient].w}x${USABLE[orient].h}mm)`);
  console.log(best
    ? `  largest type that fits one page: ${best.pt}pt   (table ${best.height}mm)`
    : `  nothing fits one page`);
}

await page.emulateMediaType(null);
await page.close();
browser.disconnect();
