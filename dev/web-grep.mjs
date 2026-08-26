// dev/web-grep.mjs
//
// Grep the standalone web app's own source for a pattern, printing a window
// around each hit. Used to recover behaviour the suite port dropped.
//
//   node dev/web-grep.mjs "no lunch|missing lunch|needs lunch|lunchWarn"
//   node dev/web-grep.mjs "warn" --window=260 --max=20
//
// PRIVACY: reads the app's code, not its data.

import puppeteer from "puppeteer-core";

const PATTERN = process.argv[2];
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? Number(a.split("=")[1]) : d;
};
const WINDOW = arg("window", 300);
const MAX = arg("max", 14);

if (!PATTERN) { console.error("usage: node dev/web-grep.mjs <regex>"); process.exit(1); }

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();

const sources = new Map();
page.on("response", async (res) => {
  const url = res.url();
  if (!/digitalmetrics-fe0f3/.test(url)) return;
  try { const body = await res.text(); if (body.length > 500) sources.set(url, body); } catch {}
});

await page.goto("https://digitalmetrics-fe0f3.web.app/", { waitUntil: "networkidle2", timeout: 90_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 5000));

const inline = await page.evaluate(() =>
  [...document.querySelectorAll("script:not([src])")].map((s) => s.textContent || ""));
inline.forEach((t, i) => { if (t.length > 500) sources.set(`inline-${i}`, t); });

const re = new RegExp(PATTERN, "gi");
let hits = 0;
for (const [url, body] of sources) {
  const seen = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(body)) && hits < MAX) {
    const bucket = Math.floor(m.index / (WINDOW / 2));
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    hits++;
    const snippet = body.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW).replace(/\s+/g, " ");
    console.log(`\n[${url.split("/").pop() || url}] … ${snippet} …`);
  }
}
if (!hits) console.log(`no match for /${PATTERN}/i in ${sources.size} source(s)`);

await page.close();
browser.disconnect();
