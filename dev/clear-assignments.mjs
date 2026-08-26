// dev/clear-assignments.mjs
//
// Clear every task on a day, writing the document directly.
//
//   node dev/clear-assignments.mjs --build=<dir> --date=2026-08-27 --store=1458
//   node dev/clear-assignments.mjs ... --dry-run
//
// Why not click the cells: hours outside an associate's shift are no longer
// focusable (data/lunch.js::isWithinShift), so the UI cannot reach assignments
// that were written before that rule existed. A document write can.
//
// The roster, shift windows and status flags are preserved — only `slots` is
// emptied. Refuses to touch a finalised day.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const DATE = arg("date");
const STORE = arg("store", "1458");
const DRY = process.argv.includes("--dry-run");
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!DATE) { console.error("✗ --date=YYYY-MM-DD is required"); process.exit(1); }

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
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3500);

const ask = (type, payload = {}) => page.evaluate((t, pl) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: t, ...pl },
    (r) => res(chrome.runtime.lastError ? { e: chrome.runtime.lastError.message } : r));
}), type, payload);

const doc = (await ask("get_assignments", { store: STORE, date: DATE }))?.data;
if (!doc?.associates?.length) {
  console.log(`nothing stored for ${STORE} on ${DATE}`);
  await page.close(); browser.disconnect(); process.exit(0);
}
if (doc.finalized) {
  console.error(`✗ ${DATE} is finalised — unfinalise it first rather than overwriting.`);
  await page.close(); browser.disconnect(); process.exit(2);
}

const before = doc.associates.reduce((n, a) =>
  n + Object.values(a.slots || {}).filter(Boolean).length, 0);
console.log(`store ${STORE}, ${DATE}: ${before} assigned cell(s) across ${doc.associates.length} associates`);

const byTask = {};
for (const a of doc.associates) {
  for (const t of Object.values(a.slots || {})) if (t) byTask[t] = (byTask[t] || 0) + 1;
}
console.log(`by task: ${JSON.stringify(byTask)}`);

if (DRY) {
  console.log("\n--dry-run: nothing written.");
  await page.close(); browser.disconnect(); process.exit(0);
}

const cleared = {
  ...doc,
  associates: doc.associates.map((a) => ({ ...a, slots: {} })),
  updatedAt: new Date().toISOString(),
};

const res = await ask("put_assignments", { store: STORE, date: DATE, doc: cleared });
if (res?.ok === false) { console.error(`✗ write failed: ${res.error}`); process.exit(1); }

await sleep(1500);
const after = ((await ask("get_assignments", { store: STORE, date: DATE }))?.data?.associates || [])
  .reduce((n, a) => n + Object.values(a.slots || {}).filter(Boolean).length, 0);
console.log(`\nassigned cells remaining: ${after} ${after === 0 ? "✓" : "✗"}`);
console.log(`roster preserved: ${((await ask("get_assignments", { store: STORE, date: DATE }))?.data?.associates || []).length} associates`);

await page.close();
browser.disconnect();
