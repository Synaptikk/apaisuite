// dev/test-vizpick-smoke.mjs
//
// The cheapest check that a real capture still works: reload the extension,
// close every Tableau tab, run a forced 3-store Today crawl from cold.
//
// Run this before pushing anything that touches the capture sources. It exists
// because `node --check` and the unit suite BOTH passed on a build where every
// Today capture died instantly with "keepAwake is not defined" — a helper was
// added to three call sites in one source while the definition went only into
// its sibling. Nothing that stops short of executing the capture can see that.
//
//   node dev/test-vizpick-smoke.mjs
//
// Read-only against Tableau.

import puppeteer from "puppeteer-core";
const EXT = process.env.APAISUITE_EXT_ID || "ckomcaimhnehdkhnngahpiboigbklpml";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 1_800_000 });
const e = await b.newPage();
await e.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
await e.evaluate((id) => new Promise((r) => chrome.developerPrivate.reload(id, {}, r)), EXT);
await e.close().catch(() => {});
await sleep(2500);
for (const p of await b.pages()) if (p.url().includes("stores.tableau.wal-mart.com")) await p.close().catch(() => {});
const app = await b.newPage();
await app.goto(`chrome-extension://${EXT}/app.html#/vizpick`, { waitUntil: "domcontentloaded" });
await sleep(3000);
const send = (m) => app.evaluate((msg) => new Promise((r) =>
  chrome.runtime.sendMessage(msg, (x) => r(x ?? { ok: false, error: String(chrome.runtime.lastError?.message) }))), m);
const st = await send({ module: "vizpick", type: "get_state" });
const market = String(st?.rows?.[0]?.market ?? "");
const stores = (st?.rows || []).filter((r) => String(r.market) === market).map((r) => r.store).slice(0, 3);
console.log(`market ${market}, stores ${stores.join(", ")} — no tabs open, cold start`);
const t0 = Date.now();
const res = await send({ module: "vizpick", type: "pull_today", stores, market, force: true });
console.log(`ok=${res?.ok} ${res?.errorClass ? `[${res.errorClass}] ` : ""}${res?.error ?? ""}`);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  storeCount=${res?.storeCount ?? 0}/${stores.length}`);
if (res?.debug?.failures?.length) console.log("failures:", JSON.stringify(res.debug.failures.slice(0, 5)));
await app.close().catch(() => {});
await b.disconnect();

process.exit(0);
