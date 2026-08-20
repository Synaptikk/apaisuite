// dev/probe-market-scope.mjs
//
// De-risk: does the Backroom/ISA report expose a per-STORE grid at market
// scope? Attaches to the running, authenticated Edge on :9222 (read-only),
// captures QES traffic, decodes EVERY grid via the real parse_dax_grid module,
// and reports each grid's dims + distinct store count.
//
//   distinct stores > 1  → market-scope per-store breakdown EXISTS (build it)
//   all grids single-store → report is store-scoped; a scope switch is needed
//
// Never logs Authorization values. Output: dev/market-scope-probe.json

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { decodeDaxGrids } from "../modules/market120/lib/parse_dax_grid.js";

const REPORT_IDS = [
  "b4835e03-3718-4b95-919f-8934bc83542c", // ISA Detail
  "c929bfda-c409-49f5-b2cb-732370411af3", // Backroom Adjustments
];

console.log("→ connecting to Edge on :9222 …");
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// Prefer an already-open report tab (keeps whatever scope you're viewing).
const targets = browser.targets().filter(
  (t) => t.type() === "page" && REPORT_IDS.some((rid) => t.url().includes(rid))
);
let page;
if (targets.length) {
  console.log(`✓ found ${targets.length} open report tab(s); using: ${targets[0].url().slice(0, 90)}…`);
  page = await targets[0].page();
} else {
  console.log("⚠ no report tab open — opening Backroom Adjustments at default (market) scope");
  page = await browser.newPage();
  await page.goto(
    "https://app.powerbi.com/groups/me/apps/a185f4ed-8506-49a6-b135-743608a56ae6" +
    "/reports/c929bfda-c409-49f5-b2cb-732370411af3/ReportSection" +
    "?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi",
    { waitUntil: "networkidle2", timeout: 60000 }
  ).catch((e) => console.log("  navigate: " + e.message));
}

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  const url = e.request.url;
  if (!/QueryExecutionService|pbidedicated|analysis\.windows\.net/i.test(url)) return;
  captured.push({ requestId: e.requestId, url, reqBody: e.request.postData ?? null, reqHeaders: e.request.headers ?? null, respBody: null });
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : (body.body || "");
  } catch {}
});

console.log("→ reloading report to trigger fresh QES queries…");
try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); }
catch (e) { console.log("  reload: " + e.message); }
console.log("→ waiting 20s for grid queries…");
await new Promise((r) => setTimeout(r, 20_000));

// Decode every response; surface grids that carry a Store dimension.
let storeGridFound = false;
console.log(`\n=== scanning ${captured.length} QES responses for per-store grids ===`);
for (let i = 0; i < captured.length; i++) {
  const { ok, grids } = decodeDaxGrids(captured[i].respBody);
  if (!ok) continue;
  for (const g of grids) {
    const storeDim = g.dimNames.find((n) => /store/i.test(n));
    if (!storeDim) continue;
    const distinct = new Set(g.rows.map((r) => String(r.dims[storeDim])));
    const tag = distinct.size > 1 ? "  🎯 MULTI-STORE (market breakdown!)" : "  (single store)";
    console.log(
      `  resp#${i}: rows=${g.rows.length}  stores=${distinct.size}  ` +
      `dims=[${g.dimNames.join(", ")}]  measures=[${g.measureNames.join(", ")}]${tag}`
    );
    if (distinct.size > 1) {
      storeGridFound = true;
      const measure = g.measureNames.find((m) => /\$|adj|amt/i.test(m)) || g.measureNames[0];
      const top = [...g.rows]
        .sort((a, b) => Math.abs((b.measures[measure] || 0)) - Math.abs((a.measures[measure] || 0)))
        .slice(0, 5);
      for (const r of top) console.log(`       store=${r.dims[storeDim]}  ${measure}=${r.measures[measure]}`);
    }
  }
}

console.log(storeGridFound
  ? "\n✅ RESULT: market-scope per-store grid EXISTS — safe to build the store table."
  : "\n⚠️ RESULT: no multi-store grid in this capture — report is store-scoped; a scope switch will be required.");

writeFileSync("market-scope-probe.json", JSON.stringify({ captured }, null, 2));
console.log("✓ Full capture → dev/market-scope-probe.json");
browser.disconnect();
process.exit(0);
