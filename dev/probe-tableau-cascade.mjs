// dev/probe-tableau-cascade.mjs
//
// The AssociatePerformance filters are a DEPENDENT CASCADE, and the control
// labels say so out loud: "Select Pick Date First", "Select Store Number(s)
// Second". Until a Pick Date is chosen the Store # filter's domain is empty,
// which is why every applyFilterAsync("Store #", …) in
// dev/probe-tableau-scope.mjs threw an error whose whole message was the
// rejected value, and why all four scoping routes returned 0 rows.
//
// So drive it the way a person does: open the date dropdown, read what is
// actually on offer, pick from it, then repeat for store — and only then ask
// the JS API for summary data.
//
//   node dev/probe-tableau-cascade.mjs --store=1458
//   node dev/probe-tableau-cascade.mjs --store=1458 --dates=3   # last N dates
//   node dev/probe-tableau-cascade.mjs --list                   # enumerate only
//
// Read-only: selects values in this session's filter controls. Nothing is
// saved to the workbook, and it runs in the dedicated debug profile.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const STORE = arg("store", "1458");
const DATE_COUNT = Number(arg("dates", "2"));
const LIST_ONLY = process.argv.includes("--list");

const URL_ = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance?:iid=1&:linktarget=_self";
const OUT = resolve(HERE, "tableau-cascade-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { store: STORE, startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60_000 });

const ok = await page.waitForFunction(
  () => { try { return (window.tableau?.VizManager?.getVizs?.() || []).length > 0; } catch { return false; } },
  { timeout: 120_000, polling: 500 },
).then(() => true).catch(() => false);
if (!ok) { out.error = "viz never registered"; save(); console.error("✗ viz never registered"); process.exit(1); }
console.log("✓ viz registered");

// The filter controls live in the viz IFRAME, not the top frame — the miss
// that made attempt D in probe-tableau-scope.mjs come back empty.
const vizFrame = async () => {
  for (const f of page.frames()) {
    try {
      if (await f.evaluate(() => !!document.querySelector('[class*="tabZone"] [role="combobox"], [role="form"] [role="combobox"]'))) return f;
    } catch {}
  }
  return null;
};
let viz = null;
const dl = Date.now() + 90_000;
while (Date.now() < dl && !viz) { viz = await vizFrame(); if (!viz) await sleep(1000); }
if (!viz) { out.error = "no frame with filter controls"; save(); console.error("✗ no filter controls found"); process.exit(1); }
console.log("✓ filter controls located" + (viz === page.mainFrame() ? " (top frame)" : " (iframe)"));
await sleep(2000);

// ── enumerate the controls ────────────────────────────────────────────────
const CONTROLS = () => {
  const found = [];
  for (const c of document.querySelectorAll('[class*="tabZone"], [role="form"]')) {
    const combo = c.querySelector('[role="combobox"]');
    if (!combo) continue;
    const txt = (c.textContent || "").trim();
    const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
    found.push({
      label: m ? m[1] : txt.slice(0, 60),
      value: (combo.textContent || "").trim(),
      zoneId: c.getAttribute("id") || c.className?.toString().slice(0, 60) || null,
    });
  }
  return found;
};
out.steps.controls = await viz.evaluate(CONTROLS);
console.log("\n→ controls:");
out.steps.controls.forEach((c, i) => console.log(`   ${i}. ${JSON.stringify(c.label)} = ${JSON.stringify(c.value)}`));
save();

// ── open one control by label and read its options ────────────────────────
const OPEN_AND_READ = async (labelNeedle) => {
  const rc = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","focus","pointerup","mouseup","click"]) {
      const E = t.startsWith("pointer") ? PointerEvent : t === "focus" ? FocusEvent : MouseEvent;
      try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
    }
    return true;
  };
  // Close anything already open so options can't be attributed to the wrong control.
  document.body.click?.();
  await new Promise((r) => setTimeout(r, 400));

  let combo = null;
  for (const c of document.querySelectorAll('[class*="tabZone"], [role="form"]')) {
    const txt = (c.textContent || "").trim();
    if (!txt.toLowerCase().includes(String(labelNeedle).toLowerCase())) continue;
    combo = c.querySelector('[role="combobox"]');
    if (combo) break;
  }
  if (!combo) return { ok: false, reason: `no combobox for ${labelNeedle}` };
  rc(combo);

  // Wait for a listbox to appear anywhere in the document.
  const deadline = Date.now() + 15000;
  let items = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const nodes = document.querySelectorAll(
      '[role="listbox"] [role="option"], [role="menu"] [role="menuitemcheckbox"], .tabMenuItemName, [data-tb-test-id*="filter-item"]');
    if (nodes.length) {
      items = [...nodes].map((n, i) => ({
        index: i,
        text: (n.textContent || "").trim().slice(0, 60),
        checked: n.getAttribute("aria-checked") ?? n.getAttribute("aria-selected") ?? null,
      })).filter((x) => x.text);
      if (items.length) break;
    }
  }
  return { ok: items.length > 0, count: items.length, items: items.slice(0, 60) };
};

console.log("\n→ opening the Pick Date control:");
out.steps.dateOptions = await viz.evaluate(OPEN_AND_READ, "Select Pick Date First");
if (!out.steps.dateOptions.ok) console.log("   ✗ " + out.steps.dateOptions.reason || "no options");
else {
  console.log(`   ✓ ${out.steps.dateOptions.count} options`);
  out.steps.dateOptions.items.slice(0, 15).forEach((o) => console.log(`     ${o.index}. ${JSON.stringify(o.text)}  checked=${o.checked}`));
}
save();

console.log("\n→ opening the Store control:");
out.steps.storeOptions = await viz.evaluate(OPEN_AND_READ, "Select Store Number");
if (!out.steps.storeOptions.ok) console.log("   ✗ " + (out.steps.storeOptions.reason || "no options"));
else {
  console.log(`   ✓ ${out.steps.storeOptions.count} options`);
  out.steps.storeOptions.items.slice(0, 15).forEach((o) => console.log(`     ${o.index}. ${JSON.stringify(o.text)}  checked=${o.checked}`));
}
save();

if (LIST_ONLY) {
  console.log(`\n✓ written to ${OUT}`);
  await page.close(); browser.disconnect(); process.exit(0);
}

// ── select: date(s) first, then store ─────────────────────────────────────
const SELECT = async (labelNeedle, wanted) => {
  const rc = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","focus","pointerup","mouseup","click"]) {
      const E = t.startsWith("pointer") ? PointerEvent : t === "focus" ? FocusEvent : MouseEvent;
      try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
    }
    return true;
  };
  document.body.click?.();
  await new Promise((r) => setTimeout(r, 400));
  let combo = null;
  for (const c of document.querySelectorAll('[class*="tabZone"], [role="form"]')) {
    const txt = (c.textContent || "").trim();
    if (!txt.toLowerCase().includes(String(labelNeedle).toLowerCase())) continue;
    combo = c.querySelector('[role="combobox"]');
    if (combo) break;
  }
  if (!combo) return { ok: false, reason: "control not found" };
  rc(combo);
  await new Promise((r) => setTimeout(r, 1500));

  const clicked = [];
  for (const want of wanted) {
    const nodes = [...document.querySelectorAll(
      '[role="listbox"] [role="option"], [role="menu"] [role="menuitemcheckbox"], .tabMenuItemName, [data-tb-test-id*="filter-item"]')];
    const hit = nodes.find((n) => (n.textContent || "").trim() === want)
             || nodes.find((n) => (n.textContent || "").trim().includes(want));
    if (hit) { rc(hit); clicked.push(want); await new Promise((r) => setTimeout(r, 600)); }
  }
  document.body.click?.();
  return { ok: clicked.length > 0, clicked };
};

const dateItems = (out.steps.dateOptions.items || []).map((i) => i.text).filter((t) => !/^\(?(All|None)\)?$/i.test(t));
const chosenDates = dateItems.slice(-DATE_COUNT);
console.log(`\n→ selecting Pick Date: ${JSON.stringify(chosenDates)}`);
out.steps.selectDate = await viz.evaluate(SELECT, "Select Pick Date First", chosenDates);
console.log("   " + JSON.stringify(out.steps.selectDate));
await sleep(8000);

console.log(`\n→ re-reading the Store control now that a date is set:`);
out.steps.storeOptionsAfter = await viz.evaluate(OPEN_AND_READ, "Select Store Number");
console.log(`   ${out.steps.storeOptionsAfter.ok ? "✓" : "✗"} ${out.steps.storeOptionsAfter.count || 0} options`);
(out.steps.storeOptionsAfter.items || []).slice(0, 10).forEach((o) => console.log(`     ${o.index}. ${JSON.stringify(o.text)}`));
save();

console.log(`\n→ selecting Store: ${STORE}`);
out.steps.selectStore = await viz.evaluate(SELECT, "Select Store Number", [STORE]);
console.log("   " + JSON.stringify(out.steps.selectStore));
await sleep(10_000);

// ── the payoff ────────────────────────────────────────────────────────────
console.log("\n→ getSummaryDataAsync after the cascade:");
out.steps.summary = await page.evaluate(async () => {
  const viz = window.tableau.VizManager.getVizs()[0];
  const active = viz.getWorkbook().getActiveSheet();
  const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
  const results = [];
  for (const ws of list) {
    try {
      const data = await ws.getSummaryDataAsync({ maxRows: 100, ignoreSelection: true });
      const cols = data.getColumns().map((c) => c.getFieldName());
      const raw = data.getData();
      results.push({
        worksheet: ws.getName?.(), ok: true, columns: cols, rowCount: raw.length,
        sample: raw.slice(0, 5).map((r) => { const o = {}; r.forEach((c, i) => { o[cols[i]] = c.formattedValue ?? c.value; }); return o; }),
      });
    } catch (e) { results.push({ worksheet: ws.getName?.(), ok: false, error: String(e?.message ?? e) }); }
  }
  return results;
});
for (const r of out.steps.summary) {
  if (!r.ok) { console.log(`   ✗ ${r.worksheet}: ${r.error}`); continue; }
  console.log(`   ${r.rowCount ? "✓" : "·"} ${JSON.stringify(r.worksheet)}: ${r.rowCount} rows`);
  if (r.rowCount) {
    console.log(`     columns: ${JSON.stringify(r.columns)}`);
    r.sample.slice(0, 3).forEach((s) => console.log(`       ${JSON.stringify(s).slice(0, 300)}`));
  }
}

save();
console.log(`\n✓ written to ${OUT}`);
await page.close();
browser.disconnect();
