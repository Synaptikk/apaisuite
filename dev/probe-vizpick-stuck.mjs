// dev/probe-vizpick-stuck.mjs
//
// Follow-up to probe-vizpick-bgtab.mjs, which showed VizPickDetails loading the
// right page (correct title + breadcrumb) but never producing a viz canvas or a
// download toolbar, in BOTH a hidden and a visible tab. That rules out
// background throttling and rules out an auth wall, so the question becomes:
// what is the page actually showing, and are the selectors we wait on still the
// right ones?
//
// Dumps the visible text, every data-tb-test-id present, any iframes, any
// error/alert nodes, and a screenshot.
//
// Read-only.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const VIEW = process.argv[2] || "VizPickDetails";
const WAIT_MS = Number(process.argv[3] || 90_000);
const REPORT_URL = `https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/${VIEW}?:iid=1&:linktarget=_self`;
const OUT = resolve(HERE, `vizpick-stuck-${VIEW}.json`);
const SHOT = resolve(HERE, `vizpick-stuck-${VIEW}.png`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null, protocolTimeout: 300_000 });
const page = await browser.newPage();
await page.bringToFront();
await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
console.log(`loaded ${VIEW}; watching for ${WAIT_MS / 1000}s`);

// Sample every 15s so a viz that renders LATE (rather than never) is visible as
// progress rather than a single pass/fail at the end.
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < WAIT_MS) {
  const s = await page.evaluate(() => ({
    t: null,
    toolbar: !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
    canvases: document.querySelectorAll("canvas").length,
    iframes: document.querySelectorAll("iframe").length,
    testIds: [...new Set([...document.querySelectorAll("[data-tb-test-id]")]
      .map((n) => n.getAttribute("data-tb-test-id")))].slice(0, 60),
    spinner: !!document.querySelector('[class*="loading" i],[class*="spinner" i],[role="progressbar"]'),
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
  })).catch((e) => ({ error: String(e) }));
  s.t = Math.round((Date.now() - t0) / 1000);
  samples.push(s);
  console.log(`  ${s.t}s toolbar=${s.toolbar} canvas=${s.canvases} iframe=${s.iframes} ids=${s.testIds?.length} spinner=${s.spinner}`);
  if (s.toolbar) break;
  await sleep(15_000);
}

const last = samples[samples.length - 1];
// Anything inside an iframe would explain an empty top document.
const frames = [];
for (const f of page.frames()) {
  frames.push({
    url: f.url().slice(0, 160),
    toolbar: await f.evaluate(() => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]')).catch(() => null),
    ids: await f.evaluate(() => [...new Set([...document.querySelectorAll("[data-tb-test-id]")].map((n) => n.getAttribute("data-tb-test-id")))].length).catch(() => null),
  });
}

await page.screenshot({ path: SHOT, fullPage: false }).catch(() => {});
writeFileSync(OUT, JSON.stringify({ view: VIEW, url: REPORT_URL, samples, frames }, null, 2));
console.log("\nframes:", JSON.stringify(frames, null, 2));
console.log("\nlast text:", last?.text);
console.log("\nlast testIds:", JSON.stringify(last?.testIds));
console.log(`\n→ ${OUT}\n→ ${SHOT}`);
await page.close().catch(() => {});
await browser.disconnect();
