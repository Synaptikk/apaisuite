// dev/probe-vizpick-source.mjs
//
// Discovery probe for the VizPick module's open questions:
//   1. What columns does the "Download Summary by Store" crosstab actually
//      contain? (Is there a real Picked denominator, or must we derive it?)
//   2. Does the workbook expose a source "last updated" timestamp, and where?
//      (Sheet index 4 is literally named "Last update (summary)".)
//   3. Is there any date/period filter at all — the dashboard footer says
//      "This dashboard is refreshed daily for the day prior", which suggests
//      the whole workbook IS yesterday and there may be no Today at all.
//
// Read-only: opens the report, reads the DOM, and drives the existing
// crosstab export (a render of data that already exists). Writes nothing
// back to Tableau.
//
// Run against a running Edge debug profile (dev/launch-edge-debug.ps1):
//   node dev/probe-vizpick-source.mjs

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const REPORT_URL =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPick?:iid=1&:linktarget=_self";
const OUT = resolve(HERE, "vizpick-source-probe.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log(`✓ connected to ${BROWSER_URL}`);

const page = await browser.newPage();

// Our own blob capture, installed in EVERY frame (Tableau creates the
// crosstab Blob inside the viz iframe, not the top document).
await page.evaluateOnNewDocument(() => {
  window.__PROBE_BLOBS = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = orig(blob);
    try {
      if (blob instanceof Blob) {
        blob.text().then((t) => window.__PROBE_BLOBS.push({ url, text: t })).catch(() => {});
      }
    } catch {}
    return url;
  };
});

console.log("→ opening VizPick…");
await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

// ── helpers ───────────────────────────────────────────────────────────────
const frameWithToolbar = async () => {
  for (const f of page.frames()) {
    try {
      const has = await f.evaluate(
        () => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]')
      );
      if (has) return f;
    } catch {}
  }
  return null;
};

// Search every frame for a captured blob matching a predicate string.
const findBlobInAnyFrame = async (needle) => {
  for (const f of page.frames()) {
    try {
      const hit = await f.evaluate(
        (n) => (window.__PROBE_BLOBS || []).filter((b) => (b.text || "").includes(n)).slice(-1)[0] || null,
        needle
      );
      if (hit) return hit;
    } catch {}
  }
  return null;
};

const clearBlobsEverywhere = async () => {
  for (const f of page.frames()) {
    try { await f.evaluate(() => { window.__PROBE_BLOBS = []; }); } catch {}
  }
};

// Drive Download → Crosstab → sheet N → CSV → Export inside the viz frame.
const driveExport = async (viz, sheetIndex) =>
  viz.evaluate(async (idx) => {
    const rc = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const o = {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, view: window,
      };
      for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","focus","pointerup","mouseup","click"]) {
        const E = t.startsWith("pointer") ? PointerEvent : t === "focus" ? FocusEvent : MouseEvent;
        try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
      }
      return true;
    };
    const tid = (t) => document.querySelector(`[data-tb-test-id="${t}"]`);
    const waitFor = async (find, ms = 25000) => {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        const el = find();
        if (el) return el;
        await new Promise((r) => setTimeout(r, 300));
      }
      return null;
    };
    const reached = {};

    const dl = await waitFor(() => tid("viz-viewer-toolbar-button-download"));
    reached.download = !!dl; rc(dl);

    const ct = await waitFor(() => tid("download-flyout-download-crosstab-MenuItem"));
    reached.crosstab = !!ct; rc(ct);

    const sheets = await waitFor(() => {
      const els = document.querySelectorAll('[data-tb-test-id^="sheet-thumbnail-"]');
      return els.length ? els : null;
    });
    reached.sheetList = !!sheets;
    const sheetNames = [...(sheets || [])].map((el, i) => ({
      index: i,
      testId: el.getAttribute("data-tb-test-id"),
      text: (el.textContent || "").trim().slice(0, 120),
    }));

    const sheet = tid(`sheet-thumbnail-${idx}`);
    reached.sheet = !!sheet;
    rc(sheet?.querySelector("img,[role=button],button,div") || sheet);

    const csv = await waitFor(() => tid("crosstab-options-dialog-radio-csv-RadioButton"));
    reached.csv = !!csv;
    rc(csv?.querySelector("input") || csv);

    const exp = await waitFor(() => {
      const e = tid("export-crosstab-export-Button");
      return e && !e.disabled ? e : null;
    });
    reached.export = !!exp;
    rc(exp);

    return { reached, sheetNames };
  }, sheetIndex);

// ── 1. Wait for the viz to render ─────────────────────────────────────────
let viz = null;
const readyDeadline = Date.now() + 90_000;
while (Date.now() < readyDeadline) {
  viz = await frameWithToolbar();
  if (viz) break;
  await sleep(1000);
}
if (!viz) {
  out.steps.vizReady = { ok: false, note: "toolbar never appeared — SSO or slow render" };
  save();
  console.error("✗ viz never rendered; tab left open for inspection");
  process.exit(1);
}
out.steps.vizReady = { ok: true, frameUrl: viz.url() };
console.log("✓ viz rendered");
await sleep(3000);

// ── 2. Scrape timestamp text + every possible filter control ──────────────
console.log("→ scanning DOM for timestamp + filter controls…");
out.steps.scan = await viz.evaluate(() => {
  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || "").trim();
    if (t) textNodes.push(t);
  }
  const DATEISH =
    /(updated|refresh|as of|last\s+load|data\s+through|yesterday|today|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}\s*(am|pm)?)/i;
  const dateish = [...new Set(textNodes.filter((t) => DATEISH.test(t) && t.length < 200))];

  // Tableau quick-filter / parameter widgets. These are NOT data-tb-test-id
  // tagged — they live in tabZone containers with tab-widget classes.
  const widgetSel = [
    '[class*="tabComboBox"]', '[class*="QuickFilter"]', '[class*="tabZoneFilter"]',
    '[class*="FilterPanel"]', '[class*="parameterControl"]', '[class*="ParameterControl"]',
    '[role="combobox"]', '[role="listbox"]', 'select', '[aria-label*="Filter" i]',
    '[class*="CategoricalFilter"]', '[class*="tabDDMenu"]',
  ].join(",");
  const widgets = [...document.querySelectorAll(widgetSel)].map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 140),
    aria: el.getAttribute("aria-label") || null,
    role: el.getAttribute("role") || null,
    text: (el.textContent || "").trim().slice(0, 100),
  }));

  // Named zones tell us what's actually on the dashboard canvas.
  const zones = [...document.querySelectorAll('[id^="tabZone"], [class*="tab-zone"]')].map((el) => ({
    id: el.id || null,
    aria: el.getAttribute("aria-label") || null,
    text: (el.textContent || "").trim().slice(0, 80),
  }));

  return { dateish, widgets, zones: zones.slice(0, 60), widgetCount: widgets.length };
});
console.log(`  dateish (${out.steps.scan.dateish.length}):`);
out.steps.scan.dateish.slice(0, 30).forEach((t) => console.log(`    · ${JSON.stringify(t)}`));
console.log(`  filter widgets (${out.steps.scan.widgetCount}):`);
out.steps.scan.widgets.slice(0, 20).forEach((w) => console.log(`    · <${w.tag}> role=${w.role} aria=${JSON.stringify(w.aria)} text=${JSON.stringify(w.text)}`));
save();

// ── 3. Export the "Last update (summary)" sheet (index 4) ─────────────────
console.log("\n→ exporting sheet 4 (Last update (summary))…");
await clearBlobsEverywhere();
const r4 = await driveExport(viz, 4);
out.steps.sheetNames = r4.sheetNames;
out.steps.export4 = { reached: r4.reached };
let lastUpdateCsv = null;
let dl4 = Date.now() + 45_000;
while (Date.now() < dl4) {
  // "Last update" sheet won't contain "Cases Seen %" — match on any blob
  // that looks like a small tab-separated table.
  const hit = await findBlobInAnyFrame("\t");
  if (hit) { lastUpdateCsv = hit.text; break; }
  await sleep(800);
}
if (lastUpdateCsv) {
  out.steps.lastUpdateCsv = { ok: true, bytes: lastUpdateCsv.length, raw: lastUpdateCsv.slice(0, 2000) };
  console.log("✓ last-update sheet CSV:");
  console.log(lastUpdateCsv.slice(0, 800));
} else {
  out.steps.lastUpdateCsv = { ok: false, note: "no blob captured for sheet 4" };
  console.log("✗ no CSV for sheet 4");
}
save();

// ── 4. Export the store summary sheet (index 2) and read its real headers ─
console.log("\n→ exporting sheet 2 (Download Summary by Store)…");
await clearBlobsEverywhere();
const r2 = await driveExport(viz, 2);
out.steps.export2 = { reached: r2.reached };
let csvText = null;
const dl2 = Date.now() + 60_000;
while (Date.now() < dl2) {
  const hit = await findBlobInAnyFrame("Cases Seen %");
  if (hit) { csvText = hit.text; break; }
  await sleep(800);
}

if (!csvText) {
  out.steps.csv = { ok: false, note: "no blob containing 'Cases Seen %' within 60s", reached: r2.reached };
  console.error(`✗ no CSV captured (stages reached: ${JSON.stringify(r2.reached)})`);
} else {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length);
  const headers = lines[0].split("\t").map((h) => h.trim());
  out.steps.csv = {
    ok: true,
    bytes: csvText.length,
    lineCount: lines.length,
    headers,
    firstRows: lines.slice(1, 5),
    totalRow: lines.find((l) => l.toLowerCase().includes("total")) || null,
  };
  console.log(`✓ CSV captured — ${lines.length} lines`);
  console.log(`  HEADERS (${headers.length}): ${JSON.stringify(headers)}`);
  lines.slice(1, 4).forEach((l, i) => console.log(`  ROW ${i + 1}: ${l}`));
  console.log(`  TOTAL: ${out.steps.csv.totalRow}`);
}

out.finishedAt = new Date().toISOString();
save();
console.log(`\n✓ wrote ${OUT}`);
await page.screenshot({ path: resolve(HERE, "vizpick-source-screenshot.png") }).catch(() => {});
browser.disconnect();
