// dev/digital-roster.mjs
//
// List the digital associates for a store, with the job title the scheduler
// gives them.
//
//   node dev/digital-roster.mjs --store=1458
//
// ── PRIVACY ────────────────────────────────────────────────────────────────
// This prints real associate names to the terminal. It writes NOTHING to disk:
// the repo is public, and a roster file is exactly what this module's whole
// design exists to keep out of it. Redirect the output yourself if you need a
// copy, and put it somewhere outside the working tree.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const STORE = arg("store", "1458");
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
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3500);

const ask = (type, payload = {}) => page.evaluate((t, pl) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "digitalmetrics", type: t, ...pl },
    (r) => res(chrome.runtime.lastError ? { e: chrome.runtime.lastError.message } : r));
}), type, payload);

const cls = (await ask("get_classifications"))?.data || {};
const dates = (await ask("list_dates", { store: STORE, collection: "schedules" }))?.data || [];

// Roles come from the schedule rows. Someone can cover a shift under a
// different job in the same week, so keep whichever title mentions digital.
const roleByName = new Map();
for (const date of dates) {
  const doc = (await ask("get_schedule", { store: STORE, date }))?.data;
  for (const a of doc?.associates || []) {
    const name = a?.name;
    const job = a?.jobName;
    if (!name || !job) continue;
    const prev = roleByName.get(name);
    if (!prev || (/\bdigital\b/i.test(job) && !/\bdigital\b/i.test(prev))) roleByName.set(name, job);
  }
}

const rows = Object.entries(cls)
  .filter(([, c]) => c === "Digital" || c === "Exceptions")
  .map(([name, c]) => ({ name, classification: c, role: roleByName.get(name) || "(not scheduled this week)" }))
  .sort((a, b) => (a.role || "").localeCompare(b.role || "") || a.name.localeCompare(b.name));

console.log(`Store ${STORE} — digital associates (${rows.length})`);
console.log(`schedule days read: ${dates.length}\n`);

let lastRole = null;
for (const r of rows) {
  if (r.role !== lastRole) {
    console.log(`\n${r.role}`);
    lastRole = r.role;
  }
  console.log(`   ${r.name.padEnd(30)} ${r.classification}`);
}

const byRole = {};
for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1;
console.log("\n── by role ──");
for (const [role, n] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)}  ${role}`);
}

await page.close();
browser.disconnect();
