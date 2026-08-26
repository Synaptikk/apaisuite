// dev/check-assigned.mjs
//
// How many cells on a day are REAL assignments versus rendered suggestions?
//
// The grid draws suggestions in the same cells as assignments (muted, via
// .dm-suggestion-hint), so a screenshot cannot tell them apart. This asks the
// stored document instead.
//
//   node dev/check-assigned.mjs --build=<dir> --date=2026-08-27 --store=1458

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const DATE = arg("date", "2026-08-27");
const STORE = arg("store", "1458");
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
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3500);

const ask = (type, payload = {}) => page.evaluate((t, pl) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: t, ...pl },
    (r) => res(chrome.runtime.lastError ? { e: chrome.runtime.lastError.message } : r));
}), type, payload);

const doc = (await ask("get_assignments", { store: STORE, date: DATE }))?.data;
const sug = (await ask("get_suggestions", { store: STORE, date: DATE }))?.data;

const assigned = [];
for (const a of doc?.associates || []) {
  for (const [slot, task] of Object.entries(a.slots || {})) {
    if (task) assigned.push({ name: a.name, slot, task });
  }
}
const sugCount = Object.values(sug || {})
  .reduce((n, slots) => n + Object.keys(slots || {}).length, 0);

console.log(`date ${DATE}, store ${STORE}`);
console.log(`stored assignments : ${assigned.length}`);
console.log(`stored suggestions : ${sugCount}`);
const byTask = {};
for (const a of assigned) byTask[a.task] = (byTask[a.task] || 0) + 1;
console.log(`by task            : ${JSON.stringify(byTask)}`);
console.log(`finalized          : ${doc?.finalized ?? false}`);
console.log(`updatedAt          : ${doc?.updatedAt ?? "(none)"}`);

await page.close();
browser.disconnect();
