// dev/test-vizpick-e2e.mjs
//
// End-to-end exercise of the VizPick module in the running Edge debug
// profile. Edge does not hot-reload extension source, so this reloads the
// extension first, then closes stale Tableau tabs (their old content scripts
// would otherwise linger), then drives the module's own UI.
//
//   node dev/test-vizpick-e2e.mjs            # yesterday refresh + UI checks
//   node dev/test-vizpick-e2e.mjs --today    # also run the per-store Today crawl
//
// Reports what it observed; it does not assert-and-exit so a partial result
// is still informative.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const EXT_NAME = "APAISuite";
const RUN_TODAY = process.argv.includes("--today");
const OUT = resolve(HERE, "vizpick-e2e-result.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log("✓ connected");

// ── 1. Find + reload the extension ────────────────────────────────────────
const extPage = await browser.newPage();
await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 15_000 });
const ext = await extPage.evaluate(async (name) => {
  const list = await new Promise((res) => chrome.developerPrivate.getExtensionsInfo({}, res));
  const e = list.find((x) => x.name === name);
  return e ? { id: e.id, version: e.version, state: e.state } : null;
}, EXT_NAME);

if (!ext) { console.error(`✗ ${EXT_NAME} not installed`); process.exit(1); }
console.log(`✓ ${EXT_NAME} ${ext.version} (${ext.id})`);
out.steps.extension = ext;

await extPage.evaluate((id) => new Promise((res) => chrome.developerPrivate.reload(id, {}, res)), ext.id);
console.log("✓ extension reloaded");
await sleep(2500);

// ── 2. Close stale tabs (old content scripts + old module page) ───────────
let closed = 0;
for (const p of await browser.pages()) {
  const u = p.url();
  if (u.includes("stores.tableau.wal-mart.com") || u.includes(`${ext.id}/app.html`)) {
    await p.close().catch(() => {});
    closed++;
  }
}
console.log(`✓ closed ${closed} stale tab(s)`);
out.steps.closedTabs = closed;
await extPage.close().catch(() => {});

// ── 3. Open the module ────────────────────────────────────────────────────
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e.message).slice(0, 300)));

await page.goto(`chrome-extension://${ext.id}/app.html#/vizpick`, { waitUntil: "domcontentloaded", timeout: 20_000 });
await sleep(3000);

const mounted = await page.$(".vizpick");
console.log(mounted ? "✓ module mounted" : "✗ module did NOT mount");
out.steps.mounted = !!mounted;
if (!mounted) {
  out.steps.consoleErrors = consoleErrors;
  save();
  console.error("console errors:", consoleErrors.slice(0, 10));
  process.exit(1);
}

// ── 4. Refresh (yesterday capture) ────────────────────────────────────────
console.log("→ clicking Refresh (this drives Tableau; ~1-2 min)…");
await page.click('[data-action="refresh"]');

const refreshDeadline = Date.now() + 240_000;
let refreshed = false;
while (Date.now() < refreshDeadline) {
  const st = await page.evaluate(() => {
    const btn = document.querySelector('[data-action="refresh"]');
    const cards = document.querySelectorAll(".vizpick-store-card").length;
    const fresh = document.querySelector('[data-freshness="stores"]')?.textContent?.trim();
    return { busy: !!btn?.disabled, cards, fresh };
  });
  if (!st.busy && (st.cards > 0 || /error/i.test(st.fresh || ""))) { refreshed = true; break; }
  await sleep(2000);
}
console.log(refreshed ? "✓ refresh finished" : "✗ refresh timed out");

// ── 5. Inspect the rendered UI ────────────────────────────────────────────
const ui = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const cards = [...document.querySelectorAll(".vizpick-store-card")];
  const grid = q(".vizpick-store-grid");
  const root = q('[class*="module-"].module-vizpick') || q(".module-vizpick");

  // Effective column count of the responsive grid.
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 0;

  // Colour-class census across all metric values.
  const census = { good: 0, warn: 0, bad: 0, neutral: 0 };
  const colours = {};
  for (const s of document.querySelectorAll(".vizpick-store-card-metric strong")) {
    const c = s.className || "";
    const key = c.includes("vizpick-good") ? "good" : c.includes("vizpick-warn") ? "warn" : c.includes("vizpick-bad") ? "bad" : "neutral";
    census[key]++;
    if (key !== "neutral" && !colours[key]) colours[key] = getComputedStyle(s).color;
  }

  return {
    market: q("[data-market-select]")?.value,
    marketOptions: document.querySelectorAll("[data-market-select] option").length,
    storeCount: cards.length,
    openCards: cards.filter((c) => c.open).length,
    gridColumns: cols,
    gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
    rootMaxWidth: root ? getComputedStyle(root).maxWidth : null,
    windowWidth: window.innerWidth,
    updatedAbs: q("[data-updated-abs]")?.textContent?.trim(),
    updatedRel: q("[data-updated-rel]")?.textContent?.trim(),
    tabYesterdayDate: q('[data-tab-date="yesterday"]')?.textContent?.trim(),
    tabTodayDate: q('[data-tab-date="today"]')?.textContent?.trim(),
    ratios: [...document.querySelectorAll(".vizpick-ratio")].slice(0, 6).map((e) => e.textContent.trim()),
    ratioCount: document.querySelectorAll(".vizpick-ratio").length,
    census,
    colours,
    freshness: q('[data-freshness="stores"]')?.textContent?.trim(),
    sampleCard: cards[0]?.innerText?.replace(/\s+/g, " ").slice(0, 300),
  };
});
out.steps.ui = ui;
console.log("\n── UI state ─────────────────────────────");
console.log(`  market selected      : ${ui.market} (of ${ui.marketOptions} options)`);
console.log(`  store cards          : ${ui.storeCount}  (open: ${ui.openCards})`);
console.log(`  grid columns × width : ${ui.gridColumns} × ${ui.gridWidth}px   window ${ui.windowWidth}px`);
console.log(`  module max-width     : ${ui.rootMaxWidth}`);
console.log(`  last updated         : ${JSON.stringify(ui.updatedAbs)} ${ui.updatedRel || ""}`);
console.log(`  tab dates            : yesterday=${JSON.stringify(ui.tabYesterdayDate)} today=${JSON.stringify(ui.tabTodayDate)}`);
console.log(`  x/y ratios rendered  : ${ui.ratioCount} — e.g. ${JSON.stringify(ui.ratios)}`);
console.log(`  colour census        : ${JSON.stringify(ui.census)}`);
console.log(`  resolved colours     : ${JSON.stringify(ui.colours)}`);
console.log(`  freshness            : ${ui.freshness}`);
console.log(`  sample card          : ${ui.sampleCard}`);
save();

// ── 6. Collapse / expand behaviour ────────────────────────────────────────
const collapse = await page.evaluate(async () => {
  const card = document.querySelector(".vizpick-store-card");
  if (!card) return null;
  const before = card.open;
  card.querySelector("summary").click();
  await new Promise((r) => setTimeout(r, 300));
  const after = card.open;
  return { before, after, store: card.dataset.store };
});
out.steps.collapse = collapse;
console.log(`\n  collapse test        : store ${collapse?.store} open ${collapse?.before} → ${collapse?.after}`);

// ── 7. Tab switch ─────────────────────────────────────────────────────────
await page.click('[data-tab="today"]');
await sleep(800);
const todayTab = await page.evaluate(() => ({
  selected: document.querySelector('[data-tab="today"]')?.getAttribute("aria-selected"),
  barVisible: !document.querySelector("[data-today-bar]")?.hidden,
  status: document.querySelector("[data-today-status]")?.textContent?.trim().slice(0, 200),
  updatedAbs: document.querySelector("[data-updated-abs]")?.textContent?.trim(),
  cards: document.querySelectorAll(".vizpick-store-card").length,
}));
out.steps.todayTab = todayTab;
console.log(`\n  today tab            : selected=${todayTab.selected} bar=${todayTab.barVisible} cards=${todayTab.cards}`);
console.log(`  today status         : ${todayTab.status}`);
await page.screenshot({ path: resolve(HERE, "vizpick-e2e-today-tab.png") }).catch(() => {});

// ── 8. Optional: run the Today crawl ──────────────────────────────────────
if (RUN_TODAY) {
  console.log("\n→ loading today's data (one export per store — minutes)…");
  await page.click('[data-action="load-today"]');
  const dl = Date.now() + 900_000;
  let last = "";
  while (Date.now() < dl) {
    const s = await page.evaluate(() => ({
      status: document.querySelector("[data-today-status]")?.textContent?.trim().slice(0, 160),
      loading: document.querySelector('[data-action="load-today"]')?.disabled,
      cards: document.querySelectorAll(".vizpick-store-card").length,
    }));
    if (s.status !== last) { console.log(`    ${s.status}`); last = s.status; }
    if (!s.loading && s.cards > 0) break;
    await sleep(3000);
  }
  out.steps.todayRun = await page.evaluate(() => ({
    cards: document.querySelectorAll(".vizpick-store-card").length,
    ratios: [...document.querySelectorAll(".vizpick-ratio")].slice(0, 4).map((e) => e.textContent.trim()),
    updatedAbs: document.querySelector("[data-updated-abs]")?.textContent?.trim(),
    status: document.querySelector("[data-today-status]")?.textContent?.trim().slice(0, 200),
    sampleCard: document.querySelector(".vizpick-store-card")?.innerText?.replace(/\s+/g, " ").slice(0, 300),
  }));
  console.log("  today result:", JSON.stringify(out.steps.todayRun, null, 2).slice(0, 1200));
  await page.screenshot({ path: resolve(HERE, "vizpick-e2e-today-loaded.png") }).catch(() => {});
}

// back to yesterday for the final screenshot
await page.click('[data-tab="yesterday"]');
await sleep(600);
await page.screenshot({ path: resolve(HERE, "vizpick-e2e-yesterday.png") }).catch(() => {});

out.steps.consoleErrors = consoleErrors;
out.finishedAt = new Date().toISOString();
save();
console.log(`\nconsole errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 8).forEach((e) => console.log(`  · ${e}`));
console.log(`✓ wrote ${OUT}`);
browser.disconnect();
