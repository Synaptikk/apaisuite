#!/usr/bin/env node
// dev/sparkrisk-e2e-probe.mjs
//
// Drives the SparkRisk module end to end in the debug Edge over CDP:
// import a JSON order file through the real file input, read the rendered
// queue, open a session detail panel, save a review, and confirm it survives
// a reload and a re-import.
//
//   ./dev/launch-edge-debug.sh
//   node dev/sparkrisk-sample-orders.mjs > /tmp/sparkrisk-sample.json
//   node dev/sparkrisk-e2e-probe.mjs /tmp/sparkrisk-sample.json
//
// Remember the mirror: the debug profile loads APAISuite-dev, so copy changed
// files there first (see MEMORY suite-install-locations).

import puppeteer from 'puppeteer-core';

const EXT_ID = process.env.SPARKRISK_EXT_ID || 'fchnolphfaklbpdgnofhblfhcailkpdb';
const FILE = process.argv[2];
if (!FILE) { console.error('usage: node dev/sparkrisk-e2e-probe.mjs <orders.json>'); process.exit(1); }

const APP = `chrome-extension://${EXT_ID}/app.html`;
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });

// Reuse an open app.html tab if there is one, otherwise open one.
let page = (await browser.pages()).find(p => p.url().startsWith(APP));
if (!page) { page = await browser.newPage(); await page.goto(APP, { waitUntil: 'domcontentloaded' }); }
await page.bringToFront();

// Reload the extension from the PAGE context: evaluating on the SW target
// hangs in this Edge build (bit twice on 2026-09-14).
// chrome.runtime.reload() tears down every extension page, so the handle we
// called it from is detached afterwards. Take a fresh one.
log('· reloading extension to pick up mirrored files');
const stale = page;
await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
await sleep(3000);
// Open the replacement BEFORE retiring the old handle: closing the last tab
// makes Edge exit, which takes the CDP connection with it.
page = await browser.newPage();
await page.bringToFront();
await page.goto(`${APP}#/sparkrisk`, { waitUntil: 'domcontentloaded' });
if (stale !== page) await stale.close().catch(() => {});
await page.waitForSelector('#sr-import-file', { timeout: 20000 });
log('· sparkrisk mounted');

// ── Import through the real file input ────────────────────────────────
await page.click('.sr-tab[data-tab="extraction"]');
const input = await page.$('#sr-import-file');
await input.uploadFile(FILE);
await page.click('#sr-extract-start-btn');

await page.waitForFunction(
  () => /complete|failed/i.test(document.querySelector('#sr-extract-status')?.textContent || ''),
  { timeout: 60000 });

const importResult = await page.evaluate(() => ({
  status: document.querySelector('#sr-extract-status')?.textContent?.trim(),
  results: document.querySelector('#sr-extract-results')?.innerText?.trim(),
  buttonDisabled: document.querySelector('#sr-extract-start-btn')?.disabled,
}));
log('\n=== IMPORT ===');
log(importResult.status);
log(importResult.results);
log('import button re-enabled:', importResult.buttonDisabled === false);

// ── Overview counters ─────────────────────────────────────────────────
await page.click('.sr-tab[data-tab="overview"]');
await sleep(800);
const overview = await page.evaluate(() => ({
  chips: [...document.querySelectorAll('.sr-context .chip')].map(c => c.innerText.replace(/\n/g, ' ').trim()),
  kpis: [...document.querySelectorAll('.kpi-card')].map(c => c.innerText.replace(/\n/g, ' | ').trim()),
  excessChartPainted: (() => {
    const c = document.querySelector('#sr-excess-chart');
    if (!c) return 'missing';
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
      return false;
    } catch (e) { return 'error: ' + e.message; }
  })(),
}));
log('\n=== OVERVIEW ===');
overview.chips.forEach(c => log(' ', c));
overview.kpis.forEach(k => log(' ', k));
log('  excess chart has pixels:', overview.excessChartPainted);

// ── Queue ─────────────────────────────────────────────────────────────
await page.click('.sr-tab[data-tab="queue"]');
await page.waitForFunction(() => document.querySelectorAll('#sr-queue-body tr.queue-row').length > 0, { timeout: 20000 });

const queue = await page.evaluate(() => {
  const head = [...document.querySelectorAll('#sr-queue-table thead th')].map(t => t.textContent.trim());
  const rows = [...document.querySelectorAll('#sr-queue-body tr.queue-row')].map(tr => ({
    sessionId: tr.dataset.session,
    cells: [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim()),
  }));
  return { head, rows };
});
log('\n=== QUEUE (' + queue.rows.length + ' rows) ===');
log(queue.head.join(' | '));
queue.rows.forEach(r => log(r.cells.join(' | ')));

// The data-session attribute must survive escaping intact: session ids are
// JSON arrays full of double quotes.
const idsIntact = queue.rows.every(r => {
  try { JSON.parse(r.sessionId.replace(/^trip:/, '')); return true; } catch { return false; }
});
log('\nsession ids survive the HTML attribute round-trip:', idsIntact);

// XSS check: the planted driver name must be TEXT, not an element.
const xss = await page.evaluate(() =>
  ({ injectedImg: !!document.querySelector('#sr-queue-body img'),
     literal: [...document.querySelectorAll('#sr-queue-body td')].some(td => td.textContent.includes('<img src=x')) }));
log('planted HTML rendered as literal text:', xss.literal, '| injected <img> present:', xss.injectedImg);

// ── Open the top session (this is the row-click regression) ───────────
await page.click('#sr-queue-body tr.queue-row');
await page.waitForFunction(
  () => !document.querySelector('#sr-detail-overlay')?.classList.contains('hidden'),
  { timeout: 10000 });
const detail = await page.evaluate(() => ({
  subtitle: document.querySelector('#sr-panel-subtitle')?.textContent?.trim(),
  score: document.querySelector('.score-big')?.textContent?.trim(),
  why: document.querySelector('.score-why')?.textContent?.trim(),
  stats: [...document.querySelectorAll('.stat-item')].map(s => s.innerText.replace(/\n/g, ': ').trim()),
  window: document.querySelector('.notice-blue')?.innerText?.replace(/\n+/g, ' / ').trim(),
}));
log('\n=== TOP SESSION DETAIL ===');
log(' ', detail.subtitle);
log('  score', detail.score);
log(' ', detail.why);
detail.stats.forEach(s => log('   ', s));
log('  window:', detail.window);

// ── Save a review, then prove it persists ─────────────────────────────
await page.select('#sr-review-status', 'confirmed');
await page.evaluate(() => { document.querySelector('#sr-review-notes').value = 'E2E probe: reviewed and confirmed'; });
page.once('dialog', d => d.accept());
await page.click('#sr-save-review');
await sleep(1500);
await page.click('#sr-panel-close');

// Re-import the SAME file: the decision must survive a full rebuild.
await page.click('.sr-tab[data-tab="extraction"]');
await (await page.$('#sr-import-file')).uploadFile(FILE);
await page.click('#sr-extract-start-btn');
await page.waitForFunction(
  () => /complete|failed/i.test(document.querySelector('#sr-extract-status')?.textContent || ''),
  { timeout: 60000 });

await page.click('.sr-tab[data-tab="queue"]');
await sleep(1200);
const after = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#sr-queue-body tr.queue-row')];
  return {
    total: rows.length,
    // Read the badge's textContent, NOT innerText: the badge is uppercased by
    // CSS text-transform, so innerText returns "CONFIRMED" and a naive
    // case-sensitive match reports a false failure.
    confirmed: rows
      .filter(r => r.querySelector('.col-status .badge')?.textContent === 'confirmed')
      .map(r => r.querySelector('td:nth-child(4)')?.textContent?.trim()),
  };
});
const stats = await page.evaluate(() => new Promise(res =>
  chrome.runtime.sendMessage({ module: 'sparkrisk', type: 'getStats' }, res)));
log('\n=== AFTER RE-IMPORT ===');
log('  queue rows:', after.total, '(must be unchanged - no duplicate sessions)');
log('  rows still marked confirmed:', JSON.stringify(after.confirmed));
log('  getStats:', JSON.stringify({
  total: stats.total, storedOrders: stats.storedOrders, ineligibleOrders: stats.ineligibleOrders,
  stores: stats.stores, highPri: stats.highPri, confirmed: stats.confirmed, cleared: stats.cleared }));

// ── Raw session dump for reading scores against intent ────────────────
const sessions = await page.evaluate(() => new Promise(res =>
  chrome.runtime.sendMessage({ module: 'sparkrisk', type: 'getQueue', limit: 200 }, res)));
log('\n=== SESSIONS (raw) ===');
log(['trip', 'store', 'driver', 'items', 'dur_min', 's/item', 'excess', 'priorN', 'dev', 'cover', 'score'].join('\t'));
for (const s of sessions.rows) {
  log([
    s.trip_id, s.store, (s.driver_key || '').slice(0, 14), s.combined_items,
    Math.round(s.session_duration_ms / 60000),
    Math.round(s.session_spi), s.excess_minutes, s.driver_prior_count,
    s.driver_deviation, s.history_coverage, s.priority_score.toFixed(1),
  ].join('\t'));
}

browser.disconnect();
