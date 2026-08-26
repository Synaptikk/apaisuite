// dev/print-check.mjs
//
// Render the Assignments tab to PDF exactly as the Print button would, and
// report how many pages it takes.
//
//   node dev/print-check.mjs --build=<dir>
//
// "Looks fine in print preview" is not a test — the grid is 65 rows x 18
// columns and the page count is the whole requirement. This produces the real
// artefact so it can be opened and read.
//
// PRIVACY: the PDF contains real associate names. It is written to
// dev/screenshots/ (gitignored for images; this one is named *-probe.pdf and
// should not be committed either).

import puppeteer from "puppeteer-core";
import { readFileSync, statSync } from "node:fs";
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

const rows = await page.evaluate(() => document.querySelectorAll(".dm-grid tbody:not(.dm-summary) tr").length);

// What print actually sees.
await page.emulateMediaType("print");
await sleep(500);
const printState = await page.evaluate(() => {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).display !== "none" : null;
  };
  return {
    sidebarVisible: vis(".shell-sidebar"),
    headerVisible: vis(".shell-header"),
    tabsVisible: vis(".module-digitalmetrics .dm-tabs"),
    toolbarVisible: vis(".module-digitalmetrics .dm-toolbar"),
    titleVisible: vis(".module-digitalmetrics .dm-print-title"),
    titleText: document.querySelector(".dm-print-title")?.textContent?.trim() ?? null,
    gridFont: getComputedStyle(document.querySelector(".dm-grid") || document.body).fontSize,
    // Measure, do not guess: A4 landscape at 6mm margins gives ~198mm usable
    // height, and 1mm is 3.7795px.
    mm: (() => {
      const px = 3.7795;
      const t = document.querySelector(".dm-grid");
      const rows = [...document.querySelectorAll(".dm-grid tbody:not(.dm-summary) tr")];
      const head = document.querySelector(".dm-grid thead");
      const sum = document.querySelector(".dm-summary");
      const hdr = document.querySelector(".module-digitalmetrics .dm-header");
      const r = (el) => el ? +(el.getBoundingClientRect().height / px).toFixed(1) : null;
      return {
        pageTitleBlock: r(hdr),
        thead: r(head),
        totals: r(sum),
        rosterTotal: r(t) && rows.length ? +(rows.reduce((n, x) => n + x.getBoundingClientRect().height, 0) / px).toFixed(1) : null,
        perRow: rows.length ? +(rows[0].getBoundingClientRect().height / px).toFixed(2) : null,
        tableTotal: r(t),
      };
    })(),
  };
});

// Who is actually setting the ink colour?
const ink = await page.evaluate(() => {
  const el = document.querySelector(".dm-name") || document.querySelector(".dm-name-cell");
  const sum = document.querySelector(".dm-summary .dm-summary-row td");
  const src = (node) => {
    if (!node) return null;
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!r.selectorText || !r.style?.color) continue;
        try { if (node.matches(r.selectorText)) out.push(`${r.selectorText} { color: ${r.style.color}${r.style.getPropertyPriority("color") ? " !important" : ""} }`); } catch {}
      }
    }
    return out.slice(-6);
  };
  return {
    nameColor: el ? getComputedStyle(el).color : null,
    nameRules: src(el),
    sumColor: sum ? getComputedStyle(sum).color : null,
    sumRules: src(sum),
  };
});
console.log("\nname colour :", ink.nameColor);
ink.nameRules?.forEach((r) => console.log("   " + r));
console.log("totals colour:", ink.sumColor);
ink.sumRules?.forEach((r) => console.log("   " + r));

// A PNG of the print-emulated page, so the result can be READ rather than
// only counted. Same media type the PDF uses.
await page.setViewport({ width: 794, height: 1123 });   // A4 portrait at 96dpi
await sleep(400);
await page.screenshot({ path: resolve(HERE, "screenshots", "print-page.png"), fullPage: true });

const out = resolve(HERE, "screenshots", "assignments-print-probe.pdf");
await page.pdf({
  path: out,
  landscape: false,
  format: "A4",
  printBackground: true,
  margin: { top: "6mm", right: "6mm", bottom: "6mm", left: "6mm" },
});
await page.emulateMediaType(null);

// Page count straight out of the PDF: count the /Type /Page objects.
const buf = readFileSync(out);
const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

console.log(`roster rows        : ${rows}`);
console.log(`sidebar in print   : ${printState.sidebarVisible ? "✗ VISIBLE" : "✓ hidden"}`);
console.log(`shell header       : ${printState.headerVisible ? "✗ VISIBLE" : "✓ hidden"}`);
console.log(`tabs / toolbar     : ${printState.tabsVisible || printState.toolbarVisible ? "✗ VISIBLE" : "✓ hidden"}`);
console.log(`print title        : ${printState.titleVisible ? "✓" : "✗"} ${JSON.stringify(printState.titleText)}`);
console.log(`grid font          : ${printState.gridFont}`);
console.log(`
heights (mm, usable ~193 after the title)`);
for (const [k, v] of Object.entries(printState.mm)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log(`\npages              : ${pages} ${pages === 1 ? "✓" : "✗ should be 1"}`);
console.log(`pdf                : ${out} (${Math.round(statSync(out).size / 1024)} KB)`);

await page.close();
browser.disconnect();
