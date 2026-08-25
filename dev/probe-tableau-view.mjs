// dev/probe-tableau-view.mjs
//
// Discovery probe for ANY Tableau view on stores.tableau.wal-mart.com.
//
// Generalises dev/probe-vizpick-view.mjs, which hardcoded the VizPick
// workbook. Written for the digitalmetrics port, whose source workbook
// (StoreFulfillmentScorecard / AssociatePerformance) is a different one.
//
//   node dev/probe-tableau-view.mjs OnlineGrocery StoreFulfillmentScorecard AssociatePerformance
//   node dev/probe-tableau-view.mjs <site> <workbook> <view> [--sheet=N]
//
// Reports, for the given view:
//   · whether the session is authenticated or sitting on an SSO wall
//   · whether the Tableau EMBEDDING JS API (window.tableau.VizManager) exists
//     — this decides whether modules/digitalmetrics/content/tableau_capture.js
//       is viable at all, or whether it has to be rewritten onto vizpick's
//       crosstab-export rails. See dev/VIZPICK_EXPORT_FINDINGS.md.
//   · the render mode (server-rendered vs client) from the bootstrap payload
//   · every quick filter and parameter control, with its current value
//   · the crosstab dialog's full sheet list (index → name)
//   · the exported CSV headers + first rows for --sheet=N
//
// Read-only: opens the view, reads the DOM, drives the built-in crosstab
// export. Never writes to Tableau, never changes a saved view.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";

const SITE     = process.argv[2] || "OnlineGrocery";
const WORKBOOK = process.argv[3] || "StoreFulfillmentScorecard";
const VIEW     = process.argv[4] || "AssociatePerformance";
const sheetArg = process.argv.find((a) => a.startsWith("--sheet="));
const FORCE_SHEET = sheetArg ? Number(sheetArg.split("=")[1]) : null;

const REPORT_URL = `https://stores.tableau.wal-mart.com/#/site/${SITE}/views/${WORKBOOK}/${VIEW}?:iid=1&:linktarget=_self`;
// Must END in "-probe.json": .gitignore matches `*-probe.json`, and these dumps
// carry live report contents (associate names among them). A name like
// "tableau-probe-<workbook>.json" puts the prefix in the wrong place and the
// file lands untracked-but-committable in a public repo.
const OUT = resolve(HERE, `tableau-${WORKBOOK}-${VIEW}-probe.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {
  site: SITE, workbook: WORKBOOK, view: VIEW, url: REPORT_URL,
  startedAt: new Date().toISOString(), steps: {},
};
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => {
    console.error(`✗ could not attach to Edge at ${BROWSER_URL}\n  Run ./dev/launch-edge-debug.sh first.\n  ${e.message}`);
    process.exit(1);
  });
console.log(`✓ attached — probing ${WORKBOOK}/${VIEW}`);

const page = await browser.newPage();

// Capture blob downloads (the crosstab export never arrives as a fetch
// response — see modules/vizpick/content/tableau_capture.js) AND the
// bootstrap payload, which is where renderMode lives.
await page.evaluateOnNewDocument(() => {
  window.__PROBE_BLOBS = [];
  window.__PROBE_BOOTSTRAP = null;
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = origCreate(blob);
    try {
      if (blob instanceof Blob) blob.text().then((t) => window.__PROBE_BLOBS.push({ url, text: t })).catch(() => {});
    } catch {}
    return url;
  };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const u = String(args[0]?.url || args[0] || "");
      if (/bootstrapSession/i.test(u)) res.clone().text().then((t) => { window.__PROBE_BOOTSTRAP = t.slice(0, 2_000_000); }).catch(() => {});
    } catch {}
    return res;
  };
});

await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3000);

// ── auth check ────────────────────────────────────────────────────────────
// A fresh debug profile lands on the SAML wall. Say so plainly rather than
// timing out 90s later on "viz never rendered".
const authState = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  bodyStart: (document.body?.innerText || "").trim().slice(0, 300),
}));
out.steps.auth = authState;
// Match on the HOST and on whole PATH SEGMENTS, never on the raw URL string.
// A bare substring test matches "sso" inside "As-so-ciatePerformance" and
// declares a perfectly good authenticated session an SSO wall.
const onSso = (() => {
  let u;
  try { u = new URL(authState.url); } catch { return false; }
  if (/(^|\.)(pfedprod|login\.microsoftonline|adfs)\./i.test(u.hostname)) return true;
  const segments = u.pathname.split("/").concat(u.hash.replace(/^#/, "").split(/[/?]/));
  if (segments.some((s) => /^(login|signin|sign-in|sso|saml2?)$/i.test(s))) return true;
  return /\bsign[- ]?in\b|\blog[- ]?in\b/i.test(authState.title);
})();
if (onSso) {
  out.error = "not authenticated";
  save();
  console.error(`\n✗ Landed on a sign-in page, not the viz.\n  url:   ${authState.url}\n  title: ${authState.title}\n`);
  console.error(`  Sign in to corporate SSO in the debug Edge window, then re-run this probe.`);
  console.error(`  (The debug profile is separate from your normal Edge and starts signed out.)`);
  process.exit(2);
}

const frameWithToolbar = async () => {
  for (const f of page.frames()) {
    try {
      if (await f.evaluate(() => !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'))) return f;
    } catch {}
  }
  return null;
};

let viz = null;
const dl = Date.now() + 90_000;
while (Date.now() < dl) { viz = await frameWithToolbar(); if (viz) break; await sleep(1000); }
if (!viz) {
  out.error = "viz never rendered";
  out.steps.finalUrl = page.url();
  save();
  console.error(`✗ no viz toolbar after 90s. Final url: ${page.url()}`);
  process.exit(1);
}
console.log("✓ viz rendered");
await sleep(4000);

// ── THE question for digitalmetrics: is the embedding JS API present? ─────
console.log("\n→ Tableau embedding JS API:");
out.steps.jsApi = await page.evaluate(() => {
  const probe = (w, label) => {
    try {
      const t = w.tableau;
      if (!t) return { frame: label, tableau: false };
      let vizCount = null;
      try { vizCount = t.VizManager?.getVizs?.().length ?? null; } catch { vizCount = "threw"; }
      return {
        frame: label,
        tableau: true,
        keys: Object.keys(t).slice(0, 25),
        hasVizManager: !!t.VizManager,
        getVizsCount: vizCount,
        hasCustomElement: !!document.querySelector("tableau-viz, tableau-authoring-viz"),
      };
    } catch (e) { return { frame: label, error: String(e?.message || e) }; }
  };
  return probe(window, "top");
});
console.log("   " + JSON.stringify(out.steps.jsApi));

// Same question inside the viz frame, where an embed would actually live.
out.steps.jsApiFrame = await viz.evaluate(() => {
  const t = window.tableau;
  if (!t) return { tableau: false, hasCustomElement: !!document.querySelector("tableau-viz, tableau-authoring-viz") };
  let vizCount = null;
  try { vizCount = t.VizManager?.getVizs?.().length ?? null; } catch { vizCount = "threw"; }
  return {
    tableau: true, keys: Object.keys(t).slice(0, 25),
    hasVizManager: !!t.VizManager, getVizsCount: vizCount,
    hasCustomElement: !!document.querySelector("tableau-viz, tableau-authoring-viz"),
  };
});
console.log("   frame: " + JSON.stringify(out.steps.jsApiFrame));

// ── render mode, from the bootstrap payload ───────────────────────────────
out.steps.renderMode = await page.evaluate(() => {
  const b = window.__PROBE_BOOTSTRAP;
  if (!b) return { captured: false };
  const mode = (b.match(/"renderMode"\s*:\s*"([^"]+)"/) || [])[1] || null;
  return {
    captured: true, bytes: b.length, renderMode: mode,
    hasDataDictionary: /"dataDictionary"\s*:\s*\{[^}]/.test(b),
    hasDataValues: /"dataValues"\s*:/.test(b),
  };
});
console.log("\n→ render mode: " + JSON.stringify(out.steps.renderMode));
save();

// ── filters + parameter controls ──────────────────────────────────────────
console.log("\n→ filter / parameter controls:");
out.steps.controls = await viz.evaluate(() => {
  const found = []; const seen = new Set();
  for (const c of [...document.querySelectorAll('[class*="tabZone"], [role="form"]')]) {
    const combo = c.querySelector('[role="combobox"]');
    const input = c.querySelector('input[type="text"], input:not([type])');
    if (!combo && !input) continue;
    const txt = (c.textContent || "").trim();
    const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
    const name = m ? (m[1] || "(unnamed)")
                   : (c.querySelector("[aria-label]")?.getAttribute("aria-label") || txt.slice(0, 60) || "(unnamed)");
    const value = (combo?.textContent || input?.value || "").trim();
    const kind = combo ? "filter" : "parameter";
    const key = kind + "||" + name + "||" + value;
    if (seen.has(key)) continue;
    seen.add(key); found.push({ kind, name, value });
  }
  return found;
});
out.steps.controls.forEach((f) => console.log(`    · [${f.kind}] ${JSON.stringify(f.name)} = ${JSON.stringify(f.value)}`));
save();

// ── crosstab sheet enumeration + optional export ──────────────────────────
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

console.log("\n→ crosstab sheet list:");
const listing = await viz.evaluate(EXPORT_FN, null);
out.steps.sheetNames = listing.sheetNames;
out.steps.listingReached = listing.reached;
listing.sheetNames.forEach((s) => console.log(`    ${String(s.index).padStart(2)} :: ${s.text}`));
save();

if (FORCE_SHEET != null) {
  await viz.evaluate(() => {
    document.querySelector('[data-tb-test-id="export-crosstab-cancel-Button"], [aria-label="Close"]')?.click();
  }).catch(() => {});
  await sleep(1500);

  console.log(`\n→ exporting sheet ${FORCE_SHEET} as CSV ...`);
  for (const f of page.frames()) { try { await f.evaluate(() => { window.__PROBE_BLOBS = []; }); } catch {} }
  const run = await viz.evaluate(EXPORT_FN, FORCE_SHEET);
  out.steps.exportReached = run.reached;

  let blob = null;
  const bdl = Date.now() + 45_000;
  while (Date.now() < bdl && !blob) {
    for (const f of page.frames()) {
      try {
        const hit = await f.evaluate(() => (window.__PROBE_BLOBS || []).slice(-1)[0] || null);
        if (hit?.text) { blob = hit; break; }
      } catch {}
    }
    if (!blob) await sleep(500);
  }

  if (!blob) {
    out.steps.export = { ok: false, reason: "no blob captured in 45s" };
    console.error("    ✗ no export blob captured");
  } else {
    const lines = String(blob.text).split(/\r?\n/);
    out.steps.export = {
      ok: true, bytes: blob.text.length, lineCount: lines.length,
      headers: lines[0] || "", sampleRows: lines.slice(1, 6),
    };
    console.log(`    ✓ ${blob.text.length} bytes, ${lines.length} lines`);
    console.log(`    headers: ${lines[0]}`);
    lines.slice(1, 4).forEach((l) => console.log(`      ${l.slice(0, 200)}`));
  }
}

save();
console.log(`\n✓ written to ${OUT}`);
await page.close();
browser.disconnect();
