// dev/list-assigned-days.mjs
//
// Which days hold assignments, and how many? Used to find test data left on
// real dates by the grid checks in this folder.
//
//   node dev/list-assigned-days.mjs --build=<dir> --store=1458

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
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

const dates = (await ask("list_dates", { store: STORE, collection: "dailyAssignments" }))?.data || [];
console.log(`store ${STORE}: ${dates.length} assignment day(s)\n`);

let total = 0;
for (const date of dates) {
  const doc = (await ask("get_assignments", { store: STORE, date }))?.data;
  const n = (doc?.associates || []).reduce((s, a) =>
    s + Object.values(a.slots || {}).filter(Boolean).length, 0);
  total += n;
  const byTask = {};
  for (const a of doc?.associates || []) {
    for (const t of Object.values(a.slots || {})) if (t) byTask[t] = (byTask[t] || 0) + 1;
  }
  console.log(`${date}  assigned:${String(n).padStart(4)}  roster:${String((doc?.associates || []).length).padStart(4)}` +
              `${doc?.finalized ? "  FINALIZED" : ""}${n ? "  " + JSON.stringify(byTask) : ""}`);
}
console.log(`\ntotal assigned cells: ${total}`);

await page.close();
browser.disconnect();
