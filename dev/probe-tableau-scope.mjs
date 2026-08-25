// dev/probe-tableau-scope.mjs
//
// How do you actually scope the AssociatePerformance view to one store?
//
// dev/probe-tableau-pull.mjs got WM_WEEK applied fine but `Store #` threw an
// error whose entire message was the value ("1458"), and the summary stayed at
// 0 rows. The v1 filter object this server serves is minified to five methods
// (getIsExcludeMode, getIsAllSelected, getAppliedValues, _updateFromJson, $9)
// — there is no getDomainAsync and no getSelectableValues, so there is no way
// to ask what it would accept.
//
// So try the plausible routes side by side and let the winner decide the
// driver's design:
//
//   A  applyFilterAsync with a NUMBER instead of a string
//   B  applyFilterAsync on the dashboard's other worksheet
//   C  URL filter parameters (?Store%20%23=1458) — Tableau's documented,
//      server-side route, and the one that needs no JS API at all
//   D  the DOM quick-filter control, i.e. what a human clicks
//
//   node dev/probe-tableau-scope.mjs --store=1458 --week=202630
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
const WEEK  = arg("week", "202630");

const BASE = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance";
const OUT  = resolve(HERE, "tableau-scope-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { store: STORE, week: WEEK, startedAt: new Date().toISOString(), attempts: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}`); process.exit(1); });
console.log("✓ attached");

// Shared helpers injected into the page for every attempt.
const PAGE_HELPERS = `
  window.wsFor = (name) => {
    const viz = window.tableau.VizManager.getVizs()[0];
    const active = viz.getWorkbook().getActiveSheet();
    const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
    // Names on this workbook carry trailing whitespace ("Associate By Day ").
    const norm = (s) => String(s || "").trim().toLowerCase();
    return list.find((s) => norm(s.getName?.()) === norm(name)) || list[0];
  };
  window.summarise = async (name) => {
    const ws = window.wsFor(name);
    const data = await ws.getSummaryDataAsync({ maxRows: 50, ignoreSelection: true });
    const cols = data.getColumns().map((c) => c.getFieldName());
    const raw = data.getData();
    return { worksheet: ws.getName?.(), columns: cols, rowCount: raw.length,
      sample: raw.slice(0, 4).map((r) => { const o = {}; r.forEach((c, i) => { o[cols[i]] = c.formattedValue ?? c.value; }); return o; }) };
  };
`;

const waitViz = async (page) => page.waitForFunction(
  () => { try { return (window.tableau?.VizManager?.getVizs?.() || []).length > 0; } catch { return false; } },
  { timeout: 120_000, polling: 500 },
).then(() => true).catch(() => false);

const report = (label, r) => {
  if (r?.error) { console.log(`   ✗ ${label}: ${r.error}`); return; }
  console.log(`   ${r?.rowCount ? "✓" : "·"} ${label}: ${r?.rowCount ?? "?"} rows${r?.columns?.length ? `, ${r.columns.length} cols` : ""}`);
  if (r?.rowCount) console.log(`       columns: ${JSON.stringify(r.columns)}`);
};

// ── A + B + D: same tab, JS API and DOM routes ────────────────────────────
{
  const page = await browser.newPage();
  await page.goto(`${BASE}?:iid=1&:linktarget=_self`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!(await waitViz(page))) { console.error("✗ viz never registered"); process.exit(1); }
  await sleep(3000);

  console.log("\n→ A: applyFilterAsync with a NUMBER");
  out.attempts.numeric = await page.evaluate(async (helpers, store, week) => {
    (0, eval)(helpers);
    const ws = window.wsFor("Associate By Day");
    const tried = [];
    for (const val of [Number(store), String(store), [Number(store)], `${store}`.padStart(5, "0")]) {
      try {
        await ws.applyFilterAsync("WM_WEEK", [week], "replace");
        await ws.applyFilterAsync("Store #", Array.isArray(val) ? val : [val], "replace");
        tried.push({ value: JSON.stringify(val), ok: true });
        break;
      } catch (e) { tried.push({ value: JSON.stringify(val), ok: false, error: String(e?.message ?? e) }); }
    }
    await new Promise((r) => setTimeout(r, 6000));
    try { return { tried, ...(await window.summarise("Associate By Day")) }; }
    catch (e) { return { tried, error: String(e?.message ?? e) }; }
  }, PAGE_HELPERS, STORE, WEEK);
  (out.attempts.numeric.tried || []).forEach((t) =>
    console.log(`     ${t.ok ? "✓" : "✗"} ${t.value}${t.error ? " — " + t.error : ""}`));
  report("A summary", out.attempts.numeric);
  save();

  console.log("\n→ B: the other worksheet (By Associate View)");
  out.attempts.otherSheet = await page.evaluate(async (helpers) => {
    (0, eval)(helpers);
    try { return await window.summarise("By Associate View"); }
    catch (e) { return { error: String(e?.message ?? e) }; }
  }, PAGE_HELPERS);
  report("B summary", out.attempts.otherSheet);
  save();

  console.log("\n→ D: DOM quick-filter controls present");
  out.attempts.domControls = await page.evaluate(() => {
    const found = [];
    for (const c of document.querySelectorAll('[class*="tabZone"], [role="form"]')) {
      const combo = c.querySelector('[role="combobox"]');
      if (!combo) continue;
      const txt = (c.textContent || "").trim();
      const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
      found.push({ label: m ? m[1] : txt.slice(0, 50), value: (combo.textContent || "").trim(),
                   testId: combo.getAttribute("data-tb-test-id") || null });
    }
    return found;
  });
  out.attempts.domControls.forEach((c) => console.log(`     · ${JSON.stringify(c.label)} = ${JSON.stringify(c.value)}`));
  save();
  await page.close();
}

// ── C: URL filter parameters, in a fresh tab ──────────────────────────────
{
  console.log("\n→ C: URL filter parameters");
  const url = `${BASE}?:iid=1&:linktarget=_self&${encodeURIComponent("Store #")}=${encodeURIComponent(STORE)}&WM_WEEK=${encodeURIComponent(WEEK)}`;
  console.log(`     ${url}`);
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!(await waitViz(page))) {
    out.attempts.urlParams = { error: "viz never registered" };
  } else {
    await sleep(10_000);
    out.attempts.urlParams = await page.evaluate(async (helpers) => {
      (0, eval)(helpers);
      try { return await window.summarise("Associate By Day"); }
      catch (e) { return { error: String(e?.message ?? e) }; }
    }, PAGE_HELPERS);
    out.attempts.urlParamsControls = await page.evaluate(() => {
      const found = [];
      for (const c of document.querySelectorAll('[class*="tabZone"], [role="form"]')) {
        const combo = c.querySelector('[role="combobox"]');
        if (!combo) continue;
        const txt = (c.textContent || "").trim();
        const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
        found.push({ label: m ? m[1] : txt.slice(0, 50), value: (combo.textContent || "").trim() });
      }
      return found;
    });
    out.attempts.urlParamsControls.forEach((c) => console.log(`     · ${JSON.stringify(c.label)} = ${JSON.stringify(c.value)}`));
  }
  report("C summary", out.attempts.urlParams);
  save();
  await page.close();
}

console.log(`\n✓ written to ${OUT}`);
browser.disconnect();
