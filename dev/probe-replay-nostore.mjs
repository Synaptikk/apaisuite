// dev/probe-replay-nostore.mjs
//
// De-risk "auto market scope" WITHOUT driving Power BI's slicer UI.
// Self-contained: attaches to :9222, captures fresh QES traffic (headers
// INCLUDED), picks a Store='1458'-filtered request, strips that condition,
// and replays it from inside the page WITH the original Authorization header.
// Checks whether the response returns a MULTI-STORE grid.
//
// Read-only intent: replays an equivalent QES *read* query; no writes.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { decodeDaxGrids } from "../modules/market120/lib/parse_dax_grid.js";

const BACKROOM_ID = "c929bfda-c409-49f5-b2cb-732370411af3";

console.log("→ connecting to Edge :9222 …");
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const targets = browser.targets().filter((t) => t.type() === "page" && t.url().includes(BACKROOM_ID));
if (!targets.length) { console.log("❌ no Backroom report tab open"); process.exit(1); }
const page = await targets[0].page();

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  const url = e.request.url;
  if (!/QueryExecutionService|pbidedicated|analysis\.windows\.net/i.test(url)) return;
  captured.push({ requestId: e.requestId, url, reqBody: e.request.postData ?? null, headers: e.request.headers ?? {} });
});

console.log("→ reloading to capture fresh requests (with headers)…");
try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); }
catch (e) { console.log("  reload: " + e.message); }
await new Promise((r) => setTimeout(r, 15_000));

const seed = captured.find(
  (r) => r.reqBody && /"Property":"Store"/.test(r.reqBody) && /'1458'/.test(r.reqBody) && /Total Adj \$/.test(r.reqBody)
);
if (!seed) { console.log(`❌ no seed among ${captured.length} requests`); process.exit(1); }
console.log(`✓ seed: ${seed.reqBody.length} bytes; has Authorization? ${!!(seed.headers.Authorization || seed.headers.authorization)}`);

// Strip the Store='1458' condition object(s) from any Where array.
function stripStoreFilter(body) {
  let obj; try { obj = JSON.parse(body); } catch { return null; }
  let removed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const s = JSON.stringify(node[i]);
        if (/"Property":"Store"/.test(s) && /'1458'/.test(s) && /"In"|"Comparison"/.test(s)) { node.splice(i, 1); removed++; }
        else walk(node[i]);
      }
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) walk(node[k]);
    }
  };
  walk(obj);
  return { body: JSON.stringify(obj), removed };
}

const stripped = stripStoreFilter(seed.reqBody);
if (!stripped?.removed) { console.log("❌ no Store='1458' condition to strip"); process.exit(1); }
console.log(`✓ stripped ${stripped.removed} condition(s); replaying market-wide…`);

// Forward the meaningful headers (esp. Authorization + activity id).
const fwd = {};
for (const [k, v] of Object.entries(seed.headers)) {
  if (/^(authorization|content-type|x-powerbi|activityid|requestid|x-ms)/i.test(k)) fwd[k] = v;
}
fwd["Content-Type"] = fwd["Content-Type"] || fwd["content-type"] || "application/json;charset=UTF-8";

const result = await page.evaluate(async (url, body, headers) => {
  try {
    const res = await fetch(url, { method: "POST", headers, body, credentials: "include" });
    return { status: res.status, text: await res.text() };
  } catch (e) { return { error: String(e) }; }
}, seed.url, stripped.body, fwd);

if (result.error) { console.log("❌ replay failed:", result.error); process.exit(1); }
console.log(`✓ replay HTTP ${result.status}, ${result.text.length} bytes`);

const { ok, grids } = decodeDaxGrids(result.text);
let multi = false;
if (ok) for (const g of grids) {
  const storeDim = g.dimNames.find((n) => /store/i.test(n));
  if (!storeDim) continue;
  const distinct = new Set(g.rows.map((r) => String(r.dims[storeDim])));
  console.log(`  grid: rows=${g.rows.length} stores=${distinct.size} dims=[${g.dimNames.join(", ")}] measures=[${g.measureNames.join(", ")}]`);
  if (distinct.size > 1) {
    multi = true;
    const measure = g.measureNames.find((m) => /\$|adj|amt/i.test(m)) || g.measureNames[0];
    const top = [...g.rows].sort((a, b) => Math.abs(b.measures[measure] || 0) - Math.abs(a.measures[measure] || 0)).slice(0, 8);
    console.log("  top stores:");
    for (const r of top) console.log(`     store=${r.dims[storeDim]}  ${measure}=${r.measures[measure]}`);
  }
}

writeFileSync("replay-nostore-probe.json", JSON.stringify({ url: seed.url, strippedBody: stripped.body, respText: result.text }, null, 2));
console.log(multi
  ? "\n✅ RESULT: request-rewrite yields a MULTI-STORE grid — clean auto-scope path confirmed!"
  : "\n⚠️ RESULT: still single/no store grid — request rewrite insufficient; slicer automation needed.");
browser.disconnect();
process.exit(0);
