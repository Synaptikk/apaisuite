// dev/probe-backroom-powerbi.mjs
//
// Purpose: find the REAL "Stolen Adj $" measure in the Backroom Adjustments
// Power BI report. The dashboard's backroom capture currently returns no
// "Stolen" descriptor — only Sum(BR Adjustments.Total Adj $) (all adjustments,
// not stolen). We need the stolen-specific measure name (and its request
// signature) to target it.
//
// Attaches to the running, authenticated Edge on :9222. Read-only. Never logs
// Authorization values. Output: dev/backroom-powerbi-probe.json + summary.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const APP_ID    = "a185f4ed-8506-49a6-b135-743608a56ae6";
const CTID      = "3cbcc3d3-094d-4006-9849-0d11d61f484d";
const REPORT_ID = "c929bfda-c409-49f5-b2cb-732370411af3";
const REPORT_URL =
  `https://app.powerbi.com/groups/me/apps/${APP_ID}/reports/${REPORT_ID}` +
  `/ReportSection?ctid=${CTID}&experience=power-bi`;

console.log("→ connecting to Edge on :9222 …");
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

const existing = browser.targets().filter(
  (t) => t.type() === "page" && new RegExp(REPORT_ID).test(t.url())
);
let page, opened = false;
if (existing.length) {
  console.log(`✓ found existing Backroom tab: ${existing[0].url().slice(0, 90)}…`);
  page = await existing[0].page();
} else {
  console.log("→ opening Backroom Adjustments report…");
  page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  opened = true;
}

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  const url = e.request.url;
  if (!/QueryExecutionService|pbidedicated|analysis\.windows\.net/i.test(url)) return;
  captured.push({ requestId: e.requestId, url, reqBody: e.request.postData ?? null, respBody: null });
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : (body.body || "");
  } catch {}
});

if (opened) {
  try { await page.goto(REPORT_URL, { waitUntil: "networkidle2", timeout: 60000 }); }
  catch (e) { console.log(`  navigate finished with: ${e.message}`); }
} else {
  try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); }
  catch (e) { console.log(`  reload finished with: ${e.message}`); }
}

console.log("→ waiting 20s for KPI-card queries…");
await new Promise((r) => setTimeout(r, 20_000));
try { await page.screenshot({ path: "backroom-powerbi-screenshot.png" }); console.log("  📸 backroom-powerbi-screenshot.png"); } catch {}

// Decode DSR descriptor names → values (mirrors parse_dax.js).
function decodeAll(respBody) {
  const seen = {};
  if (!respBody) return seen;
  let resp; try { resp = JSON.parse(respBody); } catch { return seen; }
  for (const result of (resp?.results || [])) {
    const data = result?.result?.data;
    if (!data) continue;
    const codeToName = {};
    for (const s of (data.descriptor?.Select || [])) if (s?.Value) codeToName[s.Value] = s.Name || s.Value;
    for (const ds of (data.dsr?.DS || []))
      for (const ph of (ds.PH || []))
        for (const dm of Object.keys(ph).filter((k) => /^DM\d+$/.test(k)))
          for (const row of (ph[dm] || [])) {
            for (const [k, v] of Object.entries(row)) {
              if (!/^[MG]\d+$/.test(k)) continue;
              const name = codeToName[k]; if (!name) continue;
              const val = typeof v === "string" ? Number(v) : v;
              if (Number.isFinite(val) && !(name in seen)) seen[name] = val;
            }
            if (Array.isArray(row?.S) && Array.isArray(row?.C))
              for (let i = 0; i < Math.min(row.S.length, row.C.length); i++) {
                const name = codeToName[row.S[i]?.N]; if (!name) continue;
                const raw = row.C[i]; const val = typeof raw === "string" ? Number(raw) : raw;
                if (Number.isFinite(val) && !(name in seen)) seen[name] = val;
              }
          }
  }
  return seen;
}

const all = {};
for (const r of captured) {
  const seen = decodeAll(r.respBody);
  for (const [n, v] of Object.entries(seen)) if (!(n in all)) all[n] = v;
}

console.log(`\n=== ${captured.length} QES requests; ${Object.keys(all).length} descriptors ===`);
for (const [name, val] of Object.entries(all)) {
  const flag = /stolen|shrink|theft/i.test(name) ? "  🚨 <-- STOLEN measure!"
    : /adj.*\$|total adj|amt|retail/i.test(name) ? "  💲" : "";
  console.log(`  ${JSON.stringify(name)}: ${val}${flag}`);
}

// Also scan raw request bodies for "stolen" (the filter may be in the DAX Where).
console.log("\n=== requests whose DAX body mentions 'stolen' ===");
for (const r of captured) {
  if (r.reqBody && /stolen/i.test(r.reqBody)) {
    console.log(`  ${r.url.slice(0, 70)} — reqLen=${r.reqBody.length}`);
    const idx = r.reqBody.toLowerCase().indexOf("stolen");
    console.log(`    …${r.reqBody.slice(Math.max(0, idx - 120), idx + 120)}…`);
  }
}

writeFileSync("backroom-powerbi-probe.json", JSON.stringify({ all, captured }, null, 2));
console.log("\n✓ Full capture → dev/backroom-powerbi-probe.json");
browser.disconnect();
process.exit(0);
