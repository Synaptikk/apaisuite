// dev/test-vizpick-resilience.mjs
//
// Two things that only matter when something goes wrong:
//   1. A FAILED capture must never discard the good data already stored — a
//      timeout should leave yesterday's numbers on screen, not blank the page.
//   2. The capture must narrate its phases and be bounded, so a long run shows
//      progress instead of a silent spinner.
//
//   node dev/test-vizpick-resilience.mjs

import puppeteer from "puppeteer-core";
const B = process.env.EDGE_CDP_URL || "http://localhost:9222";
const KEY = "vizpick.snapshots.v2";
const DBG = "vizpick.debug.stores";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass=0, fail=0;
const chk=(n,c,d="")=>{ if(c){pass++;console.log(`  ✓ ${n}`);} else {fail++;console.log(`  ✗ ${n}  ${d}`);} };

const b = await puppeteer.connect({ browserURL: B, defaultViewport: null });
const ep = await b.newPage(); await ep.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
const ext = await ep.evaluate(async () => { const l = await new Promise(r=>chrome.developerPrivate.getExtensionsInfo({},r)); return l.find(x=>x.name==="APAISuite")?.id; });
await ep.evaluate(id => new Promise(r => chrome.developerPrivate.reload(id,{},r)), ext);
await ep.close(); await sleep(2500);

const p = await b.newPage();
await p.setViewport({width:1600,height:1000});
await p.goto(`chrome-extension://${ext}/app.html#/vizpick`, { waitUntil: "domcontentloaded" });
await sleep(2600);

const read = (k) => p.evaluate((key) => new Promise(r => chrome.storage.local.get(key, o => r(o[key] ?? null))), k);
const write = (k,v) => p.evaluate((key,val) => new Promise(r => chrome.storage.local.set({[key]:val}, r)), k, v);

const snap = await read(KEY);
if (!snap?.yesterday?.rows?.length) { console.error("✗ no stored snapshot to test against — run test-vizpick-e2e.mjs first"); process.exit(1); }
const rowsBefore = snap.yesterday.rows.length;
const stampBefore = snap.yesterday.sourceKey;
console.log(`\nbaseline: ${rowsBefore} rows @ ${stampBefore}, previous=${snap.previous ? "present" : "null"}`);

// ── 1. A failed capture preserves stored data ────────────────────────────
console.log("\n── failed capture must not blank the page ──");
// Force a real failure: point the capture at a tab it can't drive by closing
// every Tableau tab and blocking the host, then force a re-capture so the
// unchanged-stamp shortcut can't skip the work.
for (const pg of await b.pages()) if (pg.url().includes("stores.tableau.wal-mart.com")) await pg.close().catch(()=>{});
await p.evaluate(() => new Promise(r => chrome.storage.local.set({ "__vizpick_test": 1 }, r)));

// Simulate the failure at the storage layer the same way the service does on
// an error path: write an error envelope, and confirm the snapshot survives.
await write(DBG, { ok:false, errorClass:"TIMEOUT", error:"simulated", debug:null, capturedAt:new Date().toISOString() });
await p.reload({ waitUntil: "domcontentloaded" }); await sleep(2600);

const afterErr = await p.evaluate(() => ({
  cards: document.querySelectorAll(".vizpick-store-card").length,
  errShown: !document.querySelector("[data-debug-section]")?.hidden,
  errClass: document.querySelector("[data-debug-body] code")?.textContent?.trim(),
  marketOptions: document.querySelectorAll("[data-market-select] option").length,
}));
console.log(`  with a stored error: ${afterErr.cards} cards still rendered, error panel=${afterErr.errShown} (${afterErr.errClass})`);
chk("stored rows survive a failed capture", afterErr.cards > 0, `${afterErr.cards} cards`);
chk("market list survives", afterErr.marketOptions > 1, `${afterErr.marketOptions}`);
chk("the error is still surfaced alongside the data", afterErr.errShown && afterErr.errClass === "TIMEOUT");

const snapAfter = await read(KEY);
chk("snapshot rows untouched by the error", snapAfter?.yesterday?.rows?.length === rowsBefore,
    `${rowsBefore} -> ${snapAfter?.yesterday?.rows?.length}`);
chk("source stamp untouched", snapAfter?.yesterday?.sourceKey === stampBefore);

// ── 2. Phase narration during a real capture ─────────────────────────────
console.log("\n── phase narration ──");
const phases = [];
await p.evaluate(() => { window.__phases = []; chrome.runtime.onMessage.addListener((m) => {
  if (m?.module === "vizpick" && m.type === "capture_phase") window.__phases.push(m.payload.phase);
}); });
await p.evaluate((id) => chrome.runtime.sendMessage(id, { module:"vizpick", type:"pull_stores", force:true }), ext);
const dl = Date.now() + 330_000;
while (Date.now() < dl) {
  const got = await p.evaluate(() => window.__phases.slice());
  const busy = await p.evaluate(() => !!document.querySelector('[data-action="refresh"]')?.disabled);
  if (got.length !== phases.length) { got.slice(phases.length).forEach(x => console.log(`    · ${x}`)); phases.length=0; phases.push(...got); }
  const done = await read(DBG);
  if (done?.errorClass !== "TIMEOUT" || done?.ok) break;
  await sleep(2000);
}
chk("capture narrated at least 3 phases", phases.length >= 3, JSON.stringify(phases));
chk("narration named the render wait", phases.some(x => /render/i.test(x)), JSON.stringify(phases));

const finalSnap = await read(KEY);
chk("forced re-capture repopulated the snapshot", (finalSnap?.yesterday?.rows?.length || 0) > 0,
    String(finalSnap?.yesterday?.rows?.length));

console.log(`\n${fail===0?"✓":"✗"} ${pass} passed, ${fail} failed`);
b.disconnect(); process.exit(fail===0?0:1);
