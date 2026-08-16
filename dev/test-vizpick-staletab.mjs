// dev/test-vizpick-staletab.mjs
//
// Reproduces the "live data still not loading" loop and proves the recovery.
//
// A failed capture deliberately leaves its Tableau tab open so the user can
// inspect it. findOrOpenReportTab() then hands that SAME tab to the next run.
// If it is discarded, session-expired, or was left mid-teardown, every later
// capture inherits the wreckage and fails identically — forever — on a view
// that renders in ~2s from cold. The fix reloads a reused tab once before
// giving up, and diagnoses what actually broke instead of always blaming SSO.
//
// Each scenario poisons a tab a different way, then runs a real capture:
//   discarded  — chrome.tabs.discard(), i.e. Chrome reclaiming memory
//   blank      — the viz torn out of the DOM, URL intact (what a half-dead
//                tab left by a failed export looks like)
//   healthy    — control
//
// Read-only against Tableau.

import puppeteer from "puppeteer-core";
const EXT = process.env.APAISUITE_EXT_ID || "ckomcaimhnehdkhnngahpiboigbklpml";
const DETAILS = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.connect({ browserURL: process.env.EDGE_CDP_URL || "http://localhost:9222", defaultViewport: null, protocolTimeout: 1_800_000 });

const e = await b.newPage();
await e.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
await e.evaluate((id) => new Promise((r) => chrome.developerPrivate.reload(id, {}, r)), EXT);
await e.close().catch(() => {});
await sleep(2500);
console.log("✓ extension reloaded");

const app = await b.newPage();
await app.goto(`chrome-extension://${EXT}/app.html#/vizpick`, { waitUntil: "domcontentloaded" });
await sleep(3000);
const send = (m) => app.evaluate((msg) => new Promise((r) =>
  chrome.runtime.sendMessage(msg, (resp) => r(resp ?? { ok: false, error: String(chrome.runtime.lastError?.message) }))), m);

const state = await send({ module: "vizpick", type: "get_state" });
const market = String(state?.rows?.[0]?.market ?? "");
const stores = (state?.rows || []).filter((r) => String(r.market) === market).map((r) => r.store).slice(0, 2);
console.log(`✓ market ${market}, stores ${stores.join(", ")}`);

async function closeTableauTabs() {
  for (const p of await b.pages()) if (p.url().includes("stores.tableau.wal-mart.com")) await p.close().catch(() => {});
}

async function scenario(name, poison) {
  console.log(`\n── ${name} ─────────────────────────`);
  await closeTableauTabs();

  // Leave exactly one Tableau tab open, as a failed run would.
  const t = await b.newPage();
  await t.goto(DETAILS, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(12_000);   // let it render, so "poisoning" is a real regression
  await poison(t, app);

  const t0 = Date.now();
  const res = await send({ module: "vizpick", type: "pull_today", stores, market, force: true });
  const ms = Date.now() - t0;
  console.log(`  ok=${res?.ok} ${res?.errorClass ? `[${res.errorClass}] ` : ""}${res?.error ?? ""}`);
  console.log(`  ${(ms / 1000).toFixed(1)}s, storeCount=${res?.storeCount ?? 0}/${stores.length}`);
  return { name, ok: !!res?.ok, ms, errorClass: res?.errorClass ?? null };
}

const results = [];
results.push(await scenario("healthy tab (control)", async () => {}));

results.push(await scenario("discarded tab", async (t, a) => {
  const id = await a.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://stores.tableau.wal-mart.com/*" });
    const target = tabs.find((x) => /VizPickDetails/i.test(x.url || ""));
    if (target) await chrome.tabs.discard(target.id);
    return target?.id ?? null;
  });
  console.log(`  poisoned: discarded tab ${id}`);
}));

results.push(await scenario("viz torn out of the DOM", async (t) => {
  await t.evaluate(() => { document.querySelectorAll("iframe").forEach((f) => f.remove()); });
  console.log("  poisoned: removed the viz iframe (URL unchanged)");
}));

console.log("\n── summary ──────────────────────────");
for (const r of results) {
  console.log(`  ${r.name.padEnd(26)} ${r.ok ? "RECOVERED" : `FAILED [${r.errorClass}]`}  ${(r.ms / 1000).toFixed(1)}s`);
}
await app.close().catch(() => {});
await b.disconnect();
