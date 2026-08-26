// dev/sort-check.mjs
//
// Does clicking a column header actually re-sort the Leaderboard and
// Opportunities boards, and are all the metric columns present?
//
//   node dev/sort-check.mjs --build=<dir>
//
// The unit tests assert on the rendered HTML string. This drives the real
// thing: click a header, read the first rows back, confirm the order changed
// and that a second click on the SAME header reverses it rather than doing
// nothing (the failure mode if the active-column branch is wrong).

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
await page.setViewport({ width: 1500, height: 950 });
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(2500);
await page.evaluate(() => {
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => /digital metrics/i.test((e.textContent || "").trim()))?.click();
});
await page.waitForFunction(() => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 }).catch(() => {});
await sleep(2000);

const readBoard = () => page.evaluate(() => {
  const headers = [...document.querySelectorAll(".dm-section .data-table thead th")].map((th) => ({
    label: (th.textContent || "").replace(/[↕▲▼]/g, "").trim(),
    sortKey: th.querySelector("[data-dm-sort]")?.dataset.dmSort ?? null,
    ariaSort: th.getAttribute("aria-sort"),
  }));
  const first = [...document.querySelectorAll(".dm-section .data-table tbody tr")]
    .slice(0, 4)
    .map((tr) => (tr.querySelector("[data-dm-associate]")?.textContent || "").trim());
  return { headers, first };
});

const clickHeader = async (key) => {
  const ok = await page.evaluate((k) => {
    const b = document.querySelector(`[data-dm-sort="${k}"]`);
    if (!b) return false;
    b.click();
    return true;
  }, key);
  await sleep(900);
  return ok;
};

for (const [tab, sortKey] of [["leaderboard", "nil_rate"], ["opportunities", "picked_qty"]]) {
  await page.evaluate((t) => document.querySelector(`.dm-tab[data-dm-page="${t}"]`)?.click(), tab);
  await sleep(2000);

  console.log(`\n── ${tab} ──`);
  const before = await readBoard();
  const sortable = before.headers.filter((h) => h.sortKey);
  console.log(`  columns   : ${before.headers.map((h) => h.label).join(" | ")}`);
  console.log(`  sortable  : ${sortable.length}/${before.headers.length}`);
  console.log(`  active    : ${before.headers.find((h) => h.ariaSort && h.ariaSort !== "none")?.label ?? "(none)"}`);
  console.log(`  first rows: ${before.first.join(", ")}`);

  if (!(await clickHeader(sortKey))) { console.log(`  ✗ no header with data-dm-sort="${sortKey}"`); continue; }
  const once = await readBoard();
  console.log(`  after click on "${sortKey}": ${once.first.join(", ")}`);
  const activeNow = once.headers.find((h) => h.sortKey === sortKey);
  console.log(`    aria-sort=${activeNow?.ariaSort}  ${once.first.join() !== before.first.join() ? "✓ order changed" : "✗ order unchanged"}`);

  await clickHeader(sortKey);
  const twice = await readBoard();
  const flipped = twice.headers.find((h) => h.sortKey === sortKey);
  console.log(`  second click: ${twice.first.join(", ")}`);
  console.log(`    aria-sort=${flipped?.ariaSort}  ${
    twice.first.join() !== once.first.join() && flipped?.ariaSort !== activeNow?.ariaSort
      ? "✓ reversed" : "✗ did not reverse"}`);

  await page.screenshot({ path: resolve(HERE, "screenshots", `sort-${tab}.png`) });
}

await page.close();
browser.disconnect();
