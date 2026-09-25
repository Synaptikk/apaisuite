// dev/boblisa-review-check.mjs — reload the debug-Edge extension, open BoB and Lisa,
// work the queue (Clear → hidden → Show reviewed → Undo), document a miss and check
// the cashier ledger (count, $, name, export), then remove the test record.
// Usage: node dev/boblisa-review-check.mjs <outdir>   (mirror modules/boblisa into APAISuite-dev first)
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 600000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await sleep(4000);
page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("dialog", (d) => d.accept());
await page.goto(`chrome-extension://${EXT}/app.html#/boblisa`, { waitUntil: "domcontentloaded" });

const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error("no element " + s); el.click(); }, sel);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const storage = (k) => page.evaluate((key) => chrome.storage.local.get(key).then((r) => r[key] ?? null), k);

// Wait for the pull (schema-4 days re-pull once) — rows should appear day by day.
let rows = 0, sawLiveRows = false;
for (let i = 0; i < 90; i++) {
  await sleep(4000);
  rows = await count('[data-table="manned"] .bl-row');
  const prog = await text("#boblisa-progress");
  if (rows && prog) sawLiveRows = true;
  if (i === 1) log({ statusStrip: await text("#boblisa-status") });
  if (rows && !prog) break;
  if (i % 8 === 7) log({ waiting: { rows, prog } });
}
log({ rows, sawLiveRows, tiles: await page.evaluate(() => [...document.querySelectorAll(".bl-sum")].map((e) => e.textContent.replace(/\s+/g, " ").trim())), tabs: await page.evaluate(() => [...document.querySelectorAll(".bl-tab")].map((e) => e.textContent.replace(/\s+/g, " ").trim())) });
if (!rows) { log({ errors }); browser.disconnect(); process.exit(1); }

// 1. Clear the first manned row from the row button.
const key = await page.evaluate(() => document.querySelector('[data-table="manned"] .bl-row').dataset.key);
const openBefore = Number(await text("#boblisa-cnt-manned"));
await click(`[data-table="manned"] .bl-row[data-key="${key}"] .bl-clear`);
await sleep(600);
const afterClear = {
  rowGone: !(await count(`[data-table="manned"] .bl-row[data-key="${key}"]`)),
  openCount: Number(await text("#boblisa-cnt-manned")), expected: openBefore - 1,
  chip: await text('[data-controls="manned"] .bl-chip-r'),
  stored: await storage("boblisa.review.1458"),
};
log({ afterClear: { ...afterClear, stored: afterClear.stored?.items?.[key] } });

// 2. Show reviewed → the row is back with a Cleared badge and Undo; screenshot; Undo.
await click('[data-controls="manned"] .bl-chip-r');
await sleep(400);
const shown = {
  rowBack: !!(await count(`[data-table="manned"] .bl-row[data-key="${key}"]`)),
  badge: await text(`[data-table="manned"] .bl-row[data-key="${key}"] .bl-clrd`),
  undo: !!(await count(`[data-table="manned"] .bl-row[data-key="${key}"] .bl-unclear`)),
  muted: await page.evaluate((k) => document.querySelector(`[data-table="manned"] .bl-row[data-key="${k}"]`).classList.contains("bl-done"), key),
};
await page.screenshot({ path: `${out}/boblisa-cleared.png` });
await click(`[data-table="manned"] .bl-row[data-key="${key}"] .bl-unclear`);
await sleep(600);
log({ shown, afterUndo: { openCount: Number(await text("#boblisa-cnt-manned")), stored: (await storage("boblisa.review.1458"))?.items?.[key] ?? null } });
await click('[data-controls="manned"] .bl-chip-r');   // hide reviewed again
await sleep(300);

// 3. Document the first row → cashier ledger.
await page.evaluate((k) => document.querySelector(`[data-table="manned"] .bl-row[data-key="${k}"]`).click(), key);
await sleep(400);
const detailBtns = await page.evaluate(() => [...document.querySelectorAll(".bl-doc .bl-doc-actions .btn")].map((b) => b.textContent.trim()));
await click(".bl-doc-open");
await sleep(300);
const op = await page.evaluate(() => document.querySelector("[data-docform] [name=cashierName]").placeholder.match(/op (\d+)/)?.[1]);
await page.evaluate(() => { const f = document.querySelector("[data-docform]"); f.cashierName.value = "Test Cashier"; f.note.value += " [review check]"; });
await click("[data-docform] [type=submit]");
await sleep(1200);
const docd = {
  detailBtns, op,
  rowGoneFromQueue: !(await count(`[data-table="manned"] .bl-row[data-key="${key}"]`)),
  cntDocumented: await text("#boblisa-cnt-documented"), cntCashiers: await text("#boblisa-cnt-cashiers"),
  ledger: (await storage("boblisa.cashiers.1458"))?.ledger,
};
log({ docd: { ...docd, ledger: docd.ledger && Object.values(docd.ledger).map((c) => ({ op: c.op, name: c.name, count: c.count, cents: c.cents, events: c.events.length })) } });

// 4. Cashiers tab: row, rename, events, export.
await click('.bl-tab[data-tab="cashiers"]');
await sleep(400);
const cashRow = await text('[data-table="cashiers"] .bl-cashrow');
await page.evaluate(() => { const i = document.querySelector(".bl-cash-name"); i.value = "Renamed Cashier"; i.dispatchEvent(new Event("change", { bubbles: true })); });
await sleep(800);
const renamed = { ledgerName: (await storage("boblisa.cashiers.1458"))?.ledger?.[op]?.name, recordName: (await storage("boblisa.misses.1458"))?.records?.[key]?.cashier?.name };
await page.evaluate(() => document.querySelector('[data-table="cashiers"] .bl-cashrow').click());
await sleep(300);
const events = await count(".bl-events tbody tr");
await page.screenshot({ path: `${out}/boblisa-cashiers.png` });
await click("#boblisa-cash-export");
await sleep(1500);
const toast = await page.evaluate(() => [...document.querySelectorAll(".toast, [class*=toast]")].map((e) => e.textContent.trim()).filter(Boolean).slice(-1)[0] || "");
log({ cashRow, renamed, events, exportToast: toast, foot: await text('[data-table="cashiers"] tfoot') });

// 5. Documented tab rollup uses the ledger; remove the test record → ledger empties.
await click('.bl-tab[data-tab="documented"]');
await sleep(400);
const rollup = await text("#boblisa-doc-rollup .bl-cashier");
await click(".bl-docrow .bl-doc-remove");
await sleep(1000);
log({ rollup, afterRemove: { cntCashiers: await text("#boblisa-cnt-cashiers"), ledger: (await storage("boblisa.cashiers.1458"))?.ledger, backInQueue: await page.evaluate((k) => { document.querySelector('.bl-tab[data-tab="manned"]').click(); return !!document.querySelector(`[data-table="manned"] .bl-row[data-key="${k}"]`); }, key) } });
log({ errors });
browser.disconnect();
