// dev/probe-vizpick-details-scope.mjs
//
// The VizPickDetails view (current day / "today") has no Store, Market, BU or
// Region quick filter and no "Summary by Store" crosstab sheet. Before the
// module can offer a market-wide Today tab we must know:
//
//   1. Is the view scoped to ONE store, and if so how is that store chosen —
//      a Tableau parameter, a text search box, or a URL parameter?
//   2. Do its exportable sheets ("Download Department Breakout (Current Day)",
//      "Download Location Details") carry a Store column, i.e. could a single
//      export cover a whole market?
//
// Read-only.  node dev/probe-vizpick-details-scope.mjs

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const REPORT_URL =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self";
const OUT = resolve(HERE, "vizpick-details-scope-probe.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  window.__PROBE_BLOBS = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (b) {
    const u = orig(b);
    try { if (b instanceof Blob) b.text().then((t) => window.__PROBE_BLOBS.push({ text: t })).catch(() => {}); } catch {}
    return u;
  };
});
await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

const frameWithToolbar = async () => {
  for (const f of page.frames()) {
    try { if (await f.evaluate(() => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'))) return f; } catch {}
  }
  return null;
};
const findBlob = async (needle) => {
  for (const f of page.frames()) {
    try {
      const h = await f.evaluate((n) => (window.__PROBE_BLOBS || []).filter((b) => (b.text || "").includes(n)).slice(-1)[0] || null, needle);
      if (h) return h;
    } catch {}
  }
  return null;
};
const clearBlobs = async () => { for (const f of page.frames()) { try { await f.evaluate(() => { window.__PROBE_BLOBS = []; }); } catch {} } };

let viz = null;
const dl = Date.now() + 90_000;
while (Date.now() < dl) { viz = await frameWithToolbar(); if (viz) break; await sleep(1000); }
if (!viz) { out.error = "no viz"; save(); console.error("✗ no viz"); process.exit(1); }
console.log("✓ viz rendered");
await sleep(4000);

// ── 1. every input / parameter control on the dashboard ───────────────────
console.log("\n→ inputs, parameters and search boxes:");
out.steps.controls = await viz.evaluate(() => {
  const inputs = [...document.querySelectorAll("input, textarea, [contenteditable=true]")].map((el) => ({
    type: el.type || null,
    value: el.value ?? null,
    placeholder: el.placeholder || null,
    aria: el.getAttribute("aria-label") || null,
    cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 100),
  }));
  // Tableau parameter controls (as opposed to filters) carry these classes.
  const params = [...document.querySelectorAll('[class*="parameter" i], [class*="Parameter"]')].map((el) => ({
    cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 100),
    text: (el.textContent || "").trim().slice(0, 120),
  }));
  // Any on-canvas title mentioning a store number tells us the current scope.
  const titles = [...document.querySelectorAll('[class*="tabZoneTitle"], [class*="tvTitle"], h1, h2, h3')]
    .map((el) => (el.textContent || "").trim()).filter(Boolean).slice(0, 40);
  return { inputs, params, titles };
});
out.steps.controls.inputs.forEach((i) => console.log(`    input type=${i.type} value=${JSON.stringify(i.value)} ph=${JSON.stringify(i.placeholder)} aria=${JSON.stringify(i.aria)}`));
console.log(`    parameter-ish nodes: ${out.steps.controls.params.length}`);
out.steps.controls.params.slice(0, 10).forEach((p) => console.log(`      · ${JSON.stringify(p.text)}`));
console.log("    titles:");
out.steps.controls.titles.slice(0, 20).forEach((t) => console.log(`      · ${JSON.stringify(t.slice(0, 100))}`));
save();

// ── 2. export the two "Download …" sheets and inspect their columns ───────
const EXPORT_FN = async (idx) => {
  const rc = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    for (const t of ["pointerover","mouseover","mousemove","pointerdown","mousedown","focus","pointerup","mouseup","click"]) {
      const E = t.startsWith("pointer") ? PointerEvent : t === "focus" ? FocusEvent : MouseEvent;
      try { el.dispatchEvent(new E(t, o)); } catch { el.dispatchEvent(new MouseEvent(t, o)); }
    }
    return true;
  };
  const tid = (t) => document.querySelector(`[data-tb-test-id="${t}"]`);
  const waitFor = async (find, ms = 25000) => {
    const d = Date.now() + ms;
    while (Date.now() < d) { const el = find(); if (el) return el; await new Promise((r) => setTimeout(r, 300)); }
    return null;
  };
  rc(await waitFor(() => tid("viz-viewer-toolbar-button-download")));
  rc(await waitFor(() => tid("download-flyout-download-crosstab-MenuItem")));
  await waitFor(() => document.querySelector('[data-tb-test-id^="sheet-thumbnail-"]'));
  const sheet = tid(`sheet-thumbnail-${idx}`);
  rc(sheet?.querySelector("img,[role=button],button,div") || sheet);
  const csv = await waitFor(() => tid("crosstab-options-dialog-radio-csv-RadioButton"));
  rc(csv?.querySelector("input") || csv);
  const exp = await waitFor(() => { const e = tid("export-crosstab-export-Button"); return e && !e.disabled ? e : null; });
  rc(exp);
  return !!exp;
};

for (const [idx, name] of [[3, "Download Department Breakout (Current Day)"], [4, "Download Location Details"]]) {
  console.log(`\n→ exporting sheet ${idx} :: ${name}`);
  await sleep(2000);
  await clearBlobs();
  await viz.evaluate(EXPORT_FN, idx);
  let text = null;
  const d = Date.now() + 50_000;
  while (Date.now() < d) { const h = await findBlob("\t"); if (h) { text = h.text; break; } await sleep(800); }
  if (!text) { out.steps[`sheet${idx}`] = { ok: false }; console.log("  ✗ no CSV"); continue; }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length);
  const headers = lines[0].split("\t").map((h) => h.trim());
  out.steps[`sheet${idx}`] = { ok: true, name, lineCount: lines.length, headers, firstRows: lines.slice(1, 4) };
  console.log(`  ✓ ${lines.length} lines`);
  console.log(`    HEADERS (${headers.length}): ${JSON.stringify(headers)}`);
  lines.slice(1, 3).forEach((l, i) => console.log(`    ROW ${i + 1}: ${l.slice(0, 260)}`));
  save();
}

out.finishedAt = new Date().toISOString();
save();
console.log(`\n✓ wrote ${OUT}`);
browser.disconnect();
