// dev/probe-vizpick-view.mjs
//
// Generic discovery probe for any sheet of the Tableau VizPick workbook.
// Supersedes probe-vizpick-source.mjs / probe-vizpick-datefilter.mjs by
// parameterising the view name.
//
//   node dev/probe-vizpick-view.mjs VizPick
//   node dev/probe-vizpick-view.mjs VizPickDetails
//
// For the given view it reports:
//   · every quick filter (name + current value) — including the date bucket
//   · the crosstab dialog's full sheet list (index → name)
//   · the exported CSV headers + first rows for any sheet whose name matches
//     /summary by store/i, else for --sheet=N
//   · the "Last update" sheet's value if one exists
//
// Read-only: opens the report, reads the DOM, drives the built-in crosstab
// export. Never writes to Tableau.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";

const VIEW = process.argv[2] || "VizPick";
const sheetArg = process.argv.find((a) => a.startsWith("--sheet="));
const FORCE_SHEET = sheetArg ? Number(sheetArg.split("=")[1]) : null;

const REPORT_URL = `https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/${VIEW}?:iid=1&:linktarget=_self`;
const OUT = resolve(HERE, `vizpick-view-${VIEW}-probe.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { view: VIEW, url: REPORT_URL, startedAt: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log(`✓ connected — probing view "${VIEW}"`);
const page = await browser.newPage();

await page.evaluateOnNewDocument(() => {
  window.__PROBE_BLOBS = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = orig(blob);
    try {
      if (blob instanceof Blob) blob.text().then((t) => window.__PROBE_BLOBS.push({ url, text: t })).catch(() => {});
    } catch {}
    return url;
  };
});

await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

const frameWithToolbar = async () => {
  for (const f of page.frames()) {
    try {
      if (await f.evaluate(() => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'))) return f;
    } catch {}
  }
  return null;
};
const findBlobInAnyFrame = async (needle) => {
  for (const f of page.frames()) {
    try {
      const hit = await f.evaluate(
        (n) => (window.__PROBE_BLOBS || []).filter((b) => (b.text || "").includes(n)).slice(-1)[0] || null, needle);
      if (hit) return hit;
    } catch {}
  }
  return null;
};
const clearBlobs = async () => {
  for (const f of page.frames()) { try { await f.evaluate(() => { window.__PROBE_BLOBS = []; }); } catch {} }
};

const EXPORT_FN = async (idx) => {
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
  const tid = (t) => document.querySelector(`[data-tb-test-id="${t}"]`);
  const waitFor = async (find, ms = 25000) => {
    const dl = Date.now() + ms;
    while (Date.now() < dl) { const el = find(); if (el) return el; await new Promise((r) => setTimeout(r, 300)); }
    return null;
  };
  const reached = {};
  rc(await waitFor(() => tid("viz-viewer-toolbar-button-download"))); reached.download = true;
  const ct = await waitFor(() => tid("download-flyout-download-crosstab-MenuItem"));
  reached.crosstab = !!ct; rc(ct);
  const sheets = await waitFor(() => {
    const els = document.querySelectorAll('[data-tb-test-id^="sheet-thumbnail-"]');
    return els.length ? els : null;
  });
  const sheetNames = [...(sheets || [])].map((el, i) => ({ index: i, text: (el.textContent || "").trim().slice(0, 120) }));
  if (idx == null) return { reached, sheetNames, exported: false };
  const sheet = tid(`sheet-thumbnail-${idx}`);
  reached.sheet = !!sheet;
  rc(sheet?.querySelector("img,[role=button],button,div") || sheet);
  const csv = await waitFor(() => tid("crosstab-options-dialog-radio-csv-RadioButton"));
  reached.csv = !!csv; rc(csv?.querySelector("input") || csv);
  const exp = await waitFor(() => { const e = tid("export-crosstab-export-Button"); return e && !e.disabled ? e : null; });
  reached.export = !!exp; rc(exp);
  return { reached, sheetNames, exported: true };
};

// ── wait for render ───────────────────────────────────────────────────────
let viz = null;
const dl = Date.now() + 90_000;
while (Date.now() < dl) { viz = await frameWithToolbar(); if (viz) break; await sleep(1000); }
if (!viz) { out.error = "viz never rendered"; save(); console.error("✗ no viz"); process.exit(1); }
console.log("✓ viz rendered");
await sleep(4000);

// ── filters ───────────────────────────────────────────────────────────────
console.log("\n→ quick filters:");
out.steps.filters = await viz.evaluate(() => {
  const cards = [...document.querySelectorAll('[class*="tabZone"], [role="form"]')];
  const seen = new Set(); const found = [];
  for (const c of cards) {
    const combo = c.querySelector('[role="combobox"]');
    if (!combo) continue;
    const txt = (c.textContent || "").trim();
    const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
    const name = m ? (m[1] || "(unnamed)") : "(no Filter prefix)";
    const value = (combo.textContent || "").trim();
    const key = name + "||" + value;
    if (seen.has(key)) continue;
    seen.add(key); found.push({ name, value });
  }
  return found;
});
out.steps.filters.forEach((f) => console.log(`    · ${JSON.stringify(f.name)} = ${JSON.stringify(f.value)}`));

// ── date-ish text (footer notes, "Updated", etc.) ─────────────────────────
out.steps.dateish = await viz.evaluate(() => {
  const t = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const s = (n.textContent || "").trim(); if (s) t.push(s); }
  const RE = /(updated|refresh|as of|data\s+through|yesterday|today|current\s+day|live|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i;
  return [...new Set(t.filter((s) => RE.test(s) && s.length < 200))];
});
console.log("\n→ date-ish text:");
out.steps.dateish.slice(0, 20).forEach((t) => console.log(`    · ${JSON.stringify(t)}`));
save();

// ── enumerate crosstab sheets ─────────────────────────────────────────────
console.log("\n→ crosstab sheet list:");
const listing = await viz.evaluate(EXPORT_FN, null);
out.steps.sheetNames = listing.sheetNames;
listing.sheetNames.forEach((s) => console.log(`    ${String(s.index).padStart(2)} :: ${s.text}`));
save();

// close the dialog before re-opening for a real export
await viz.evaluate(() => {
  const c = document.querySelector('[data-tb-test-id="export-crosstab-cancel-Button"], [data-tb-test-id*="cancel"], [aria-label="Close"]');
  c?.click();
}).catch(() => {});
await sleep(1500);

// ── pick the store-summary sheet and export it ────────────────────────────
const storeSheet =
  FORCE_SHEET != null
    ? { index: FORCE_SHEET, text: "(forced)" }
    : listing.sheetNames.find((s) => /summary by store/i.test(s.text)) ||
      listing.sheetNames.find((s) => /store/i.test(s.text));

if (!storeSheet) {
  console.log("\n✗ no store-ish sheet found; nothing to export");
} else {
  console.log(`\n→ exporting sheet ${storeSheet.index} :: ${storeSheet.text}`);
  await clearBlobs();
  const r = await viz.evaluate(EXPORT_FN, storeSheet.index);
  out.steps.export = { sheet: storeSheet, reached: r.reached };
  let csvText = null;
  const d2 = Date.now() + 60_000;
  while (Date.now() < d2) { const h = await findBlobInAnyFrame("\t"); if (h) { csvText = h.text; break; } await sleep(800); }
  if (csvText) {
    const lines = csvText.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length);
    const headers = lines[0].split("\t").map((h) => h.trim());
    out.steps.csv = { ok: true, lineCount: lines.length, headers, firstRows: lines.slice(1, 5) };
    console.log(`✓ ${lines.length} lines`);
    console.log(`  HEADERS (${headers.length}): ${JSON.stringify(headers)}`);
    lines.slice(1, 4).forEach((l, i) => console.log(`  ROW ${i + 1}: ${l.slice(0, 300)}`));
  } else {
    out.steps.csv = { ok: false, reached: r.reached };
    console.log(`✗ no CSV captured (reached: ${JSON.stringify(r.reached)})`);
  }
}

// ── last-update sheet, if the workbook has one ────────────────────────────
const luSheet = listing.sheetNames.find((s) => /last\s*update/i.test(s.text));
if (luSheet) {
  console.log(`\n→ exporting sheet ${luSheet.index} :: ${luSheet.text}`);
  await sleep(1500);
  await clearBlobs();
  await viz.evaluate(EXPORT_FN, luSheet.index);
  let lu = null;
  const d3 = Date.now() + 45_000;
  while (Date.now() < d3) { const h = await findBlobInAnyFrame("\t"); if (h) { lu = h.text; break; } await sleep(800); }
  out.steps.lastUpdate = lu ? { ok: true, raw: lu.slice(0, 500) } : { ok: false };
  console.log(lu ? `✓ last update: ${JSON.stringify(lu.slice(0, 200))}` : "✗ no last-update CSV");
} else {
  out.steps.lastUpdate = { ok: false, note: "no 'Last update' sheet in this view" };
  console.log("\n(no 'Last update' sheet in this view)");
}

out.finishedAt = new Date().toISOString();
save();
console.log(`\n✓ wrote ${OUT}`);
await page.screenshot({ path: resolve(HERE, `vizpick-view-${VIEW}.png`) }).catch(() => {});
browser.disconnect();
