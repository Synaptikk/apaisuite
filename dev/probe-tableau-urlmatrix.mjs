// dev/probe-tableau-urlmatrix.mjs
//
// Does URL filtering scope AssociatePerformance?
//
// probe-tableau-scope.mjs attempt C sent only `Store #` and got 0 rows — but
// that test was confounded: the cascade ("Select Pick Date First") means a
// store alone can never produce data, so 0 rows says nothing about whether the
// URL parameter was honoured. This retries with BOTH halves of the cascade and
// several spellings, because Tableau matches URL filter keys against the field
// name, the caption, or the parameter name depending on how the author
// published the control.
//
//   node dev/probe-tableau-urlmatrix.mjs --store=1458 --date=2026-08-22
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
const DATE  = arg("date", "2026-08-22");

const BASE = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/StoreFulfillmentScorecard/AssociatePerformance";
const OUT  = resolve(HERE, "tableau-urlmatrix-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { store: STORE, date: DATE, startedAt: new Date().toISOString(), trials: [] };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

// Same date in the spellings Tableau accepts for a date filter, plus the
// M/D/YYYY the workbook's own "Pick Date" column renders in.
const d = new Date(`${DATE}T00:00:00`);
const slash = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

const TRIALS = [
  { name: "field names, ISO date",      params: { "Pick Date": DATE,  "Store #": STORE } },
  { name: "field names, M/D/YYYY",      params: { "Pick Date": slash, "Store #": STORE } },
  { name: "captions",                   params: { "Select Pick Date First": slash, "Select Store Number(s) Second": STORE } },
  { name: "field names + WM_WEEK",      params: { "Pick Date": slash, "Store #": STORE, "WM_WEEK": "202630" } },
];

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}`); process.exit(1); });
console.log("✓ attached");

for (const trial of TRIALS) {
  const qs = Object.entries(trial.params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const url = `${BASE}?:iid=1&:linktarget=_self&${qs}`;
  console.log(`\n→ ${trial.name}`);

  const page = await browser.newPage();
  const rec = { ...trial, url };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const ok = await page.waitForFunction(
      () => { try { return (window.tableau?.VizManager?.getVizs?.() || []).length > 0; } catch { return false; } },
      { timeout: 120_000, polling: 500 },
    ).then(() => true).catch(() => false);
    if (!ok) { rec.error = "viz never registered"; }
    else {
      await sleep(12_000);
      // What did the controls actually end up showing? This is the real signal:
      // a control that moved off "(None)" means the URL parameter was honoured.
      rec.controls = await (async () => {
        for (const f of page.frames()) {
          try {
            const got = await f.evaluate(() => {
              const seen = new Set(); const found = [];
              for (const c of document.querySelectorAll('[class*="tabZone"], [role="form"]')) {
                const combo = c.querySelector('[role="combobox"]');
                if (!combo) continue;
                const txt = (c.textContent || "").trim();
                const m = txt.match(/^Filter\s*(.*?)\s*(Inclusive|Exclusive)/);
                const label = m ? m[1] : txt.slice(0, 50);
                const value = (combo.textContent || "").trim();
                const k = label + "=" + value;
                if (seen.has(k)) continue;
                seen.add(k); found.push({ label, value });
              }
              return found;
            });
            if (got.length) return got;
          } catch {}
        }
        return [];
      })();
      rec.summary = await page.evaluate(async () => {
        const viz = window.tableau.VizManager.getVizs()[0];
        const active = viz.getWorkbook().getActiveSheet();
        const list = active.getSheetType?.() === "dashboard" ? active.getWorksheets() : [active];
        const res = [];
        for (const ws of list) {
          try {
            const data = await ws.getSummaryDataAsync({ maxRows: 50, ignoreSelection: true });
            const cols = data.getColumns().map((c) => c.getFieldName());
            const raw = data.getData();
            res.push({
              worksheet: ws.getName?.(), rowCount: raw.length, columns: cols,
              sample: raw.slice(0, 3).map((r) => { const o = {}; r.forEach((c, i) => { o[cols[i]] = c.formattedValue ?? c.value; }); return o; }),
            });
          } catch (e) { res.push({ worksheet: ws.getName?.(), error: String(e?.message ?? e) }); }
        }
        return res;
      });
    }
  } catch (e) { rec.error = String(e?.message ?? e); }

  (rec.controls || []).filter((c) => /Pick Date|Store Number/i.test(c.label))
    .forEach((c) => console.log(`     ${JSON.stringify(c.label)} = ${JSON.stringify(c.value)}`));
  for (const s of rec.summary || []) {
    console.log(`     ${s.rowCount ? "✓" : "·"} ${JSON.stringify(s.worksheet)}: ${s.rowCount ?? "err"} rows`);
    if (s.rowCount) {
      console.log(`       columns: ${JSON.stringify(s.columns)}`);
      s.sample.slice(0, 2).forEach((x) => console.log(`         ${JSON.stringify(x).slice(0, 280)}`));
    }
  }
  if (rec.error) console.log(`     ✗ ${rec.error}`);

  out.trials.push(rec);
  save();
  await page.close();

  if ((rec.summary || []).some((s) => s.rowCount > 0)) {
    console.log("\n★ this spelling works — stopping here.");
    break;
  }
}

console.log(`\n✓ written to ${OUT}`);
browser.disconnect();
