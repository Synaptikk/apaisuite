#!/usr/bin/env node
// dev/sparkrisk-1458-eval.mjs
//
// Loads a real store corpus into the SparkRisk module and reports where the
// Auror-confirmed theft orders land in the priority queue.
//
//   node dev/sparkrisk-1458-eval.mjs <orders.json> <labels.json>
//
// READ THIS BEFORE QUOTING ANY NUMBER IT PRINTS:
// the labelled positive set that overlaps store 1458 is tiny (single digits).
// Rank positions for a handful of cases are an anecdote, not a hit rate. This
// script deliberately prints the positives' ranks AND the score distribution
// of the whole corpus, because the second is what tells you whether a rank is
// meaningful or just where most trips happen to sit.
//
// It WIPES the module's IndexedDB first so baselines are built only from the
// corpus being evaluated.

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const EXT_ID = process.env.SPARKRISK_EXT_ID || 'fchnolphfaklbpdgnofhblfhcailkpdb';
const [FILE, LABELS] = process.argv.slice(2);
if (!FILE || !LABELS) { console.error('usage: node dev/sparkrisk-1458-eval.mjs <orders.json> <labels.json>'); process.exit(1); }

const APP = `chrome-extension://${EXT_ID}/app.html`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const labelFile = JSON.parse(readFileSync(LABELS, 'utf8'));
const positives = new Set((labelFile.theft_orders_total || labelFile.orders || []).map(String));
log(`labelled theft orders in file: ${positives.size}`);

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
let page = (await browser.pages()).find(p => p.url().startsWith(APP));
if (!page) { page = await browser.newPage(); await page.goto(APP, { waitUntil: 'domcontentloaded' }); }
await page.bringToFront();

// ── Wipe, so baselines come only from this corpus ──────────────────────
log('· deleting the sparkrisk IndexedDB');
await page.evaluate(() => new Promise(res => {
  const r = indexedDB.deleteDatabase('sparkrisk');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
const stale = page;
await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
await sleep(3000);
page = await browser.newPage();
await page.bringToFront();
await page.goto(`${APP}#/sparkrisk`, { waitUntil: 'domcontentloaded' });
if (stale !== page) await stale.close().catch(() => {});
await page.waitForSelector('#sr-import-file', { timeout: 30000 });

// ── Import ─────────────────────────────────────────────────────────────
log('· importing (this is ~8.9k orders, give it a minute)');
const t0 = Date.now();
await page.click('.sr-tab[data-tab="extraction"]');
await (await page.$('#sr-import-file')).uploadFile(FILE);
await page.click('#sr-extract-start-btn');
await page.waitForFunction(
  () => /complete|failed/i.test(document.querySelector('#sr-extract-status')?.textContent || ''),
  { timeout: 600000, polling: 1000 });
log(`· import finished in ${Math.round((Date.now() - t0) / 1000)}s`);
log(await page.evaluate(() => document.querySelector('#sr-extract-results')?.innerText?.trim()
  || document.querySelector('#sr-extract-status')?.textContent));

// ── Pull every scored session ──────────────────────────────────────────
const q = await page.evaluate(() => new Promise(res =>
  chrome.runtime.sendMessage({ module: 'sparkrisk', type: 'getQueue', limit: 100000 }, res)));
const rows = q.rows.map(r => ({
  session_id: r.session_id, trip_id: r.trip_id, score: r.priority_score,
  items: r.combined_items, orders: r.order_count, excess: r.excess_minutes,
  spi: r.session_spi, priorN: r.driver_prior_count, dev: r.driver_deviation,
  cover: r.history_coverage, driver: r.driver_key,
  order_ids: (() => { try { return JSON.parse(r.order_ids || '[]').map(String); } catch { return []; } })(),
}));
rows.sort((a, b) => b.score - a.score);
log(`\nscored sessions: ${rows.length}`);

// ── Score distribution of the whole corpus ─────────────────────────────
const scores = rows.map(r => r.score).sort((a, b) => a - b);
const pct = p => scores[Math.min(scores.length - 1, Math.floor(p / 100 * scores.length))];
log('\n=== SCORE DISTRIBUTION (all scored sessions) ===');
log(`  min ${scores[0].toFixed(1)}  p25 ${pct(25).toFixed(1)}  median ${pct(50).toFixed(1)}  p75 ${pct(75).toFixed(1)}  p90 ${pct(90).toFixed(1)}  p99 ${pct(99).toFixed(1)}  max ${scores[scores.length - 1].toFixed(1)}`);
for (const band of [[75, 100], [60, 75], [45, 60], [0.0001, 45], [-1, 0.0001]]) {
  const n = scores.filter(s => s > band[0] && s <= band[1]).length;
  const label = band[0] === -1 ? 'exactly 0' : `${band[0]}–${band[1]}`;
  log(`  ${label.padStart(10)}: ${String(n).padStart(5)}  (${(n / scores.length * 100).toFixed(1)}%)`);
}

// ── Where do the confirmed cases land? ─────────────────────────────────
const byOrder = new Map();
rows.forEach((r, i) => r.order_ids.forEach(id => byOrder.set(id, { ...r, rank: i + 1 })));

log('\n=== AUROR-CONFIRMED ORDERS IN THIS CORPUS ===');
const found = [];
for (const id of positives) {
  const hit = byOrder.get(id);
  if (hit) found.push({ id, ...hit });
}
if (!found.length) {
  log('  none of the labelled orders produced a scored session.');
} else {
  log('  order_id          rank / total    score   items  s/item  excess  priorN   dev   coverage');
  for (const f of found.sort((a, b) => a.rank - b.rank)) {
    // Percentile FROM THE TOP: rank 1 is the top 0.0%, the last row ~100%.
    const pctile = (100 * f.rank / rows.length).toFixed(1);
    log(`  ${f.id}  ${String(f.rank).padStart(5)} / ${rows.length}  (top ${pctile}%)  ${String(f.score.toFixed(1)).padStart(5)}  ${String(f.items).padStart(4)}  ${String(Math.round(f.spi)).padStart(5)}  ${String(f.excess).padStart(6)}  ${String(f.priorN).padStart(5)}  ${String(f.dev ?? '—').padStart(6)}  ${f.cover}`);
  }
  const ranks = found.map(f => f.rank);
  const inTopPct = p => ranks.filter(r => r <= rows.length * p / 100).length;
  log(`\n  confirmed cases found: ${found.length} of ${positives.size} labelled`);
  log(`  in the top 1%  (rank <= ${Math.round(rows.length * 0.01)}): ${inTopPct(1)}`);
  log(`  in the top 5%  (rank <= ${Math.round(rows.length * 0.05)}): ${inTopPct(5)}`);
  log(`  in the top 10% (rank <= ${Math.round(rows.length * 0.10)}): ${inTopPct(10)}`);
  log(`  in the top 50% (rank <= ${Math.round(rows.length * 0.50)}): ${inTopPct(50)}`);
  const expected = found.length * 0.05;
  log(`\n  For reference, picking ${found.length} sessions at random would put ${expected.toFixed(2)} of them in the top 5%.`);
}

// Labelled orders that never became a scored session, and why.
const missing = [...positives].filter(id => !byOrder.has(id));
if (missing.length) {
  const src = JSON.parse(readFileSync(FILE, 'utf8')).orders;
  const idx = new Map(src.map(o => [String(o.order_id), o]));
  const present = missing.filter(id => idx.has(id));
  if (present.length) {
    log(`\n  labelled orders present in the import but NOT scored: ${present.length}`);
    for (const id of present.slice(0, 10)) {
      const o = idx.get(id);
      log(`    ${id}: status=${o.status} qty=${o.total_order_qty} pick=${o.pick_started_time} disp=${o.dispatched_time}`);
    }
  }
}

browser.disconnect();
