// dev/probe-vizpick-datefilter.mjs
//
// Follow-up to probe-vizpick-source.mjs. That probe found an unnamed Tableau
// quick filter whose current value is "1. Yesterday", plus worksheets called
// "Show Bucket" / "summary date bucket name". Before building Today /
// Yesterday tabs we need to know what that filter can actually be set to —
// specifically whether a "Today" bucket exists at all, given the dashboard
// footer says "This dashboard is refreshed daily for the day prior."
//
// Read-only in the sense that matters: it opens a filter dropdown and reads
// the option list. It does NOT apply a different value or save anything to
// the workbook (Tableau filter state on a view is per-session unless
// explicitly saved as a custom view).
//
//   node dev/probe-vizpick-datefilter.mjs

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const REPORT_URL =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPick?:iid=1&:linktarget=_self";
const OUT = resolve(HERE, "vizpick-datefilter-probe.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log(`✓ connected`);
const page = await browser.newPage();
await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

const frameWithToolbar = async () => {
  for (const f of page.frames()) {
    try {
      if (await f.evaluate(() => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]')))
        return f;
    } catch {}
  }
  return null;
};

let viz = null;
const dl = Date.now() + 90_000;
while (Date.now() < dl) { viz = await frameWithToolbar(); if (viz) break; await sleep(1000); }
if (!viz) { out.error = "viz never rendered"; save(); console.error("✗ no viz"); process.exit(1); }
console.log("✓ viz rendered");
await sleep(4000);

// ── Inventory every quick filter on the dashboard, with its label + value ──
console.log("→ inventorying quick filters…");
out.steps.filters = await viz.evaluate(() => {
  // A Tableau quick filter renders as a container whose text starts with
  // "Filter <name> Inclusive|Exclusive". The current value sits in a
  // role="combobox" span inside it.
  const cards = [...document.querySelectorAll('[class*="tabZone"], [role="form"]')];
  const seen = new Set();
  const found = [];
  for (const c of cards) {
    const combo = c.querySelector('[role="combobox"]');
    if (!combo) continue;
    const txt = (c.textContent || "").trim();
    const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
    const name = m ? (m[1] || "(unnamed)") : "(no Filter prefix)";
    const value = (combo.textContent || "").trim();
    const key = name + "||" + value;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name, value, containerClass: (c.className?.baseVal ?? c.className ?? "").toString().slice(0, 120) });
  }
  return found;
});
out.steps.filters.forEach((f) => console.log(`    · name=${JSON.stringify(f.name)} value=${JSON.stringify(f.value)}`));
save();

// ── Open the combobox currently showing "1. Yesterday" and list options ────
console.log("\n→ opening the date-bucket dropdown…");
out.steps.openResult = await viz.evaluate(async () => {
  const rc = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","pointerup","mouseup","click"]) {
      const E = t.startsWith("pointer") ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
    }
    return true;
  };

  const combos = [...document.querySelectorAll('[role="combobox"]')];
  const target = combos.find((c) => /yesterday/i.test(c.textContent || ""));
  if (!target) return { ok: false, reason: "no combobox containing 'Yesterday'", combos: combos.map((c) => (c.textContent || "").trim()) };

  rc(target);
  await new Promise((r) => setTimeout(r, 1500));

  // The dropdown renders into a floating menu near the end of <body>.
  const menuSel = '[class*="tabMenu"], [role="listbox"], [class*="DropdownMenu"], [class*="tabDDMenu"], [class*="facetOverflow"]';
  const menus = [...document.querySelectorAll(menuSel)].filter((m) => m.offsetParent !== null || m.getClientRects().length);
  const options = [];
  for (const m of menus) {
    for (const li of m.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [class*="FIItem"], li, [class*="ValueItem"]')) {
      const t = (li.textContent || "").trim();
      if (t && t.length < 80) options.push(t);
    }
  }

  // Fallback: some Tableau builds render the value list inline in the card.
  const inlineItems = [...document.querySelectorAll('[class*="FICheckRadio"], [class*="facetItem"]')]
    .map((el) => (el.textContent || "").trim()).filter(Boolean);

  return {
    ok: true,
    menuCount: menus.length,
    options: [...new Set(options)],
    inlineItems: [...new Set(inlineItems)].slice(0, 40),
  };
});
console.log(JSON.stringify(out.steps.openResult, null, 2).slice(0, 3000));
save();

await page.screenshot({ path: resolve(HERE, "vizpick-datefilter-screenshot.png") }).catch(() => {});
out.finishedAt = new Date().toISOString();
save();
console.log(`\n✓ wrote ${OUT}`);
browser.disconnect();
