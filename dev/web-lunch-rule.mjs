// dev/web-lunch-rule.mjs
//
// Recover the lunch alert/warning rule from the standalone web app.
//
// The suite port has no lunch logic at all — grep finds only the button label
// — so the rule has to come from the original rather than be guessed. Wrong
// thresholds here would flag compliant shifts and miss real ones.
//
//   node dev/web-lunch-rule.mjs
//
// PRIVACY: reads the app's own JavaScript, not its data. Prints code, not
// associate records.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "web-lunch-rule.txt");

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null })
  .catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });

const page = await browser.newPage();
const sources = new Map();

page.on("response", async (res) => {
  const url = res.url();
  if (!/\.js(\?|$)/.test(url) && !/\/$/.test(url)) return;
  try {
    const body = await res.text();
    if (/lunch/i.test(body)) sources.set(url, body);
  } catch {}
});

await page.goto("https://digitalmetrics-fe0f3.web.app/", { waitUntil: "networkidle2", timeout: 90_000 })
  .catch(() => {});
await new Promise((r) => setTimeout(r, 6000));

// Inline scripts too — the app may be a single HTML file.
const inline = await page.evaluate(() =>
  [...document.querySelectorAll("script:not([src])")].map((s) => s.textContent || "")
    .filter((t) => /lunch/i.test(t)));
inline.forEach((t, i) => sources.set(`inline-${i}`, t));

if (!sources.size) {
  console.log("no source mentioning 'lunch' was loaded — the app may lazy-load it.");
  await page.close(); browser.disconnect(); process.exit(0);
}

const chunks = [];
for (const [url, body] of sources) {
  console.log(`\n=== ${url} (${body.length} bytes) ===`);
  chunks.push(`=== ${url} ===\n`);
  // Print a window around every mention, so the surrounding rule is visible.
  const re = /lunch/gi;
  const seen = new Set();
  let m;
  while ((m = re.exec(body))) {
    const start = Math.max(0, m.index - 320);
    const end = Math.min(body.length, m.index + 320);
    const key = Math.floor(start / 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = body.slice(start, end).replace(/\s+/g, " ");
    console.log(`  … ${snippet} …\n`);
    chunks.push(`… ${snippet} …\n`);
    if (seen.size > 14) break;
  }
}

writeFileSync(OUT, chunks.join("\n"));
console.log(`\n✓ written to ${OUT}`);

await page.close();
browser.disconnect();
