// dev/test-vizpick-lanes.mjs
//
// Measures the Today crawl at 1 background tab vs 3, through the real
// extension path (message -> service worker -> source), and checks that the
// parallel run does not lose rows to the storage read-modify-write race.
//
//   node dev/test-vizpick-lanes.mjs            # 3 stores, lanes 1 then 3
//   node dev/test-vizpick-lanes.mjs 6          # 6 stores
//   node dev/test-vizpick-lanes.mjs 6 3        # only lanes=3
//
// Both runs pass force:true so neither can be skipped by the unchanged-stamp
// path — otherwise the second run would "finish" in seconds having done
// nothing and look like an enormous speedup.
//
// Read-only against Tableau: sets a view parameter and exports data.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const EXT_NAME = "APAISuite";
const N_STORES = Number(process.argv[2] || 3);
const ONLY_LANES = process.argv[3] ? [Number(process.argv[3])] : [1, 3];
const OUT = resolve(HERE, "vizpick-lanes-result.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), nStores: N_STORES, runs: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null, protocolTimeout: 1_800_000 });
console.log("✓ connected");

// ── Reload the extension so this run tests the source on disk ─────────────
const extPage = await browser.newPage();
await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 15_000 });
const ext = await extPage.evaluate(async (name) => {
  const list = await new Promise((res) => chrome.developerPrivate.getExtensionsInfo({}, res));
  const e = list.find((x) => x.name === name);
  return e ? { id: e.id, version: e.version } : null;
}, EXT_NAME);
if (!ext) { console.error(`✗ ${EXT_NAME} not installed`); process.exit(1); }
await extPage.evaluate((id) => new Promise((res) => chrome.developerPrivate.reload(id, {}, res)), ext.id);
await extPage.close().catch(() => {});
console.log(`✓ ${EXT_NAME} ${ext.version} reloaded`);
await sleep(2500);

// Stale Tableau tabs carry old content scripts and would be reused as lane 0.
let closed = 0;
for (const p of await browser.pages()) {
  if (p.url().includes("stores.tableau.wal-mart.com")) { await p.close().catch(() => {}); closed++; }
}
console.log(`✓ closed ${closed} stale Tableau tab(s)`);

// ── An extension page, so chrome.runtime.sendMessage reaches the SW ───────
const page = await browser.newPage();
await page.goto(`chrome-extension://${ext.id}/app.html#/vizpick`, { waitUntil: "domcontentloaded", timeout: 20_000 });
await sleep(3000);

const send = (msg) => page.evaluate(
  (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r ?? { ok: false, error: String(chrome.runtime.lastError?.message) }))),
  msg
);

// ── Roster: which stores exist, from the stored yesterday capture ─────────
let state = await send({ module: "vizpick", type: "get_state" });
if (!state?.rows?.length) {
  console.log("→ no roster stored; running the yesterday capture first…");
  const r = await send({ module: "vizpick", type: "pull_stores" });
  console.log(`  stores capture: ok=${r?.ok} ${r?.error || ""}`);
  state = await send({ module: "vizpick", type: "get_state" });
}
const market = state?.rows?.[0]?.market ?? null;
const stores = (state?.rows || []).filter((r) => r.market === market).map((r) => r.store).slice(0, N_STORES);
console.log(`✓ market ${market}, testing ${stores.length} store(s): ${stores.join(", ")}`);
out.market = market;
out.stores = stores;
if (!stores.length) { console.error("✗ no stores in the roster — cannot measure"); save(); process.exit(1); }

// ── The measured runs ─────────────────────────────────────────────────────
for (const lanes of ONLY_LANES) {
  console.log(`\n── lanes=${lanes} ───────────────────────────`);
  const t0 = Date.now();
  const res = await send({ module: "vizpick", type: "pull_today", stores, market, force: true, concurrency: lanes });
  const ms = Date.now() - t0;

  // Read back what actually landed in storage — the point of the race check is
  // that the RETURN value can look complete while the persisted rows are short.
  const after = await send({ module: "vizpick", type: "get_state" });
  const persisted = (after?.today?.rows || []).map((r) => r.store);
  const missing = stores.filter((s) => !persisted.includes(s));

  out.runs[`lanes${lanes}`] = {
    ok: !!res?.ok, ms, perStoreMs: Math.round(ms / stores.length),
    error: res?.error ?? null, errorClass: res?.errorClass ?? null,
    storeCount: res?.storeCount ?? null,
    lanesUsed: res?.debug?.lanes ?? null,
    persisted: persisted.length, missing,
    failures: res?.debug?.failures ?? null,
  };
  save();

  console.log(`  ok=${res?.ok} ${res?.error ? `— ${res.error}` : ""}`);
  console.log(`  wall clock : ${(ms / 1000).toFixed(1)}s  (${(ms / 1000 / stores.length).toFixed(1)}s/store)`);
  console.log(`  persisted  : ${persisted.length}/${stores.length}${missing.length ? `  ✗ MISSING ${missing.join(",")}` : "  ✓ no rows lost"}`);
  if (res?.debug?.failures?.length) {
    console.log(`  failures   : ${JSON.stringify(res.debug.failures.slice(0, 6))}`);
  }
}

const a = out.runs.lanes1, b = out.runs.lanes3;
if (a?.ok && b?.ok) {
  console.log(`\n── speedup ──────────────────────────────`);
  console.log(`  1 lane : ${(a.ms / 1000).toFixed(1)}s`);
  console.log(`  3 lanes: ${(b.ms / 1000).toFixed(1)}s   → ${(a.ms / b.ms).toFixed(2)}× faster`);
}
out.finishedAt = new Date().toISOString();
save();
console.log(`\n→ ${OUT}`);
await browser.disconnect();
