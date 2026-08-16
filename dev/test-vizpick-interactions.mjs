// dev/test-vizpick-interactions.mjs
//
// Covers the three behaviours the main e2e can't: drag-to-rearrange (with
// persistence across a reload), suppression of the per-export file download,
// and that the capture never steals focus from the user's tab.
//
//   node dev/test-vizpick-interactions.mjs

import puppeteer from "puppeteer-core";
const B = process.env.EDGE_CDP_URL || "http://localhost:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

const b = await puppeteer.connect({ browserURL: B, defaultViewport: null });
const ep = await b.newPage();
await ep.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
const ext = await ep.evaluate(async () => {
  const l = await new Promise((r) => chrome.developerPrivate.getExtensionsInfo({}, r));
  return l.find((x) => x.name === "APAISuite")?.id || null;
});
await ep.close();

const page = await b.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(`chrome-extension://${ext}/app.html#/vizpick`, { waitUntil: "domcontentloaded" });
await sleep(2500);

// ── 1. Drag to rearrange ─────────────────────────────────────────────────
console.log("\n── drag to rearrange ──");
const before = await page.evaluate(() => [...document.querySelectorAll(".vizpick-store-card")].map((c) => c.dataset.store));
console.log(`  before: ${before.join(" ")}`);

const dragged = await page.evaluate(async () => {
  const cards = [...document.querySelectorAll(".vizpick-store-card")];
  if (cards.length < 4) return null;
  const src = cards[0], dst = cards[3];
  const dt = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(src, "dragstart");
  fire(dst, "dragover");
  fire(dst, "drop");
  fire(src, "dragend");
  await new Promise((r) => setTimeout(r, 600));
  return { moved: src.dataset.store, onto: dst.dataset.store };
});
const after = await page.evaluate(() => [...document.querySelectorAll(".vizpick-store-card")].map((c) => c.dataset.store));
console.log(`  after : ${after.join(" ")}   (moved ${dragged?.moved} onto ${dragged?.onto})`);
check("order changed", JSON.stringify(before) !== JSON.stringify(after));
check("dragged card landed in the target slot", after[3] === dragged?.moved, `index3=${after[3]}`);
check("no cards lost or duplicated", after.length === before.length && new Set(after).size === after.length);
check("sort control switched to custom", await page.evaluate(() => document.querySelector("[data-sort-select]")?.value) === "custom");

// persistence across a full reload
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(2500);
const afterReload = await page.evaluate(() => [...document.querySelectorAll(".vizpick-store-card")].map((c) => c.dataset.store));
console.log(`  reload: ${afterReload.join(" ")}`);
check("custom arrangement survived a reload", JSON.stringify(afterReload) === JSON.stringify(after));

// reset restores store-asc
await page.evaluate(() => document.querySelector('[data-action="reset-order"]')?.click());
await sleep(600);
const reset = await page.evaluate(() => [...document.querySelectorAll(".vizpick-store-card")].map((c) => Number(c.dataset.store)));
check("reset order returns to store ascending", reset.every((v, i) => i === 0 || reset[i - 1] <= v), JSON.stringify(reset));

// ── 2. Download suppression + no focus steal ─────────────────────────────
console.log("\n── refresh: downloads + focus ──");
const dlBefore = await page.evaluate(() => new Promise((r) => chrome.downloads.search({}, (d) => r(d.length))));
const myTabId = await page.evaluate(() => new Promise((r) => chrome.tabs.getCurrent((t) => r(t?.id ?? null))));
console.log(`  downloads before: ${dlBefore}`);

await page.evaluate(() => document.querySelector('[data-action="refresh"]').click());
// Sample which tab is active while the capture runs.
const activeSamples = new Set();
const dl = Date.now() + 240_000;
let done = false;
while (Date.now() < dl) {
  const st = await page.evaluate(() => ({
    busy: !!document.querySelector('[data-action="refresh"]')?.disabled,
    cards: document.querySelectorAll(".vizpick-store-card").length,
  }));
  const act = await page.evaluate(() => new Promise((r) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => r(t[0]?.url?.slice(0, 60) ?? null))));
  if (act) activeSamples.add(act);
  if (!st.busy && st.cards > 0) { done = true; break; }
  await sleep(1500);
}
const dlAfter = await page.evaluate(() => new Promise((r) => chrome.downloads.search({}, (d) => r(d.length))));
console.log(`  downloads after : ${dlAfter}`);
console.log(`  tabs seen active during capture: ${JSON.stringify([...activeSamples])}`);
check("refresh completed", done);
check("no new downloads created", dlAfter === dlBefore, `${dlBefore} → ${dlAfter}`);
check("Tableau never became the active tab", ![...activeSamples].some((u) => u.includes("tableau")), JSON.stringify([...activeSamples]));

const suppressed = await page.evaluate(() => new Promise((r) =>
  chrome.storage.local.get("vizpick.debug.stores", (o) => r(o["vizpick.debug.stores"]?.ok ?? null))));
check("capture still succeeded with downloads suppressed", suppressed === true, String(suppressed));

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
b.disconnect();
process.exit(fail === 0 ? 0 : 1);
