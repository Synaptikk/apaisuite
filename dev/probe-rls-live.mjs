// probe-rls-live.mjs
//
// DEFINITIVE read-only RLS scope test (fresh-capture + immediate replay).
// 1. Attach to authenticated Edge :9222, find the AP - Field Reports tab.
// 2. Reload; capture a FRESH ISA/Backroom grid QES request (with live auth
//    headers) that carries the Region/Market/Store hierarchy.
// 3. Strip the Store filter, replay via CDP Runtime in the page with the
//    SAME fresh headers -> returns whatever regions/markets RLS permits.
// 4. Report distinct Region + Market codes visible to this account.
//
// Read-only: pure SELECT/QES data query, no writes. Authorization values are
// never printed. Output: rls-live-probe.json

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const targets = browser.targets().filter((t) => t.type() === "page" && t.url().includes("app.powerbi.com"));
if (!targets.length) { console.log("no Power BI tab open"); process.exit(1); }
const page = await targets[0].page();

const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
let grid = null;
cdp.on("Network.requestWillBeSent", (e) => {
  const b = e.request.postData || "";
  if (!/pbidedicated|analysis\.windows\.net/i.test(e.request.url)) return;
  if (grid) return;
  if (/BU Hierarchy/.test(b) && /"Property":"Store"/.test(b) && /'1458'/.test(b)) {
    grid = { url: e.request.url, headers: e.request.headers, body: b };
  }
});

console.log("→ reloading to capture a fresh grid query…");
try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); } catch {}
for (let i = 0; i < 20 && !grid; i++) await new Promise((r) => setTimeout(r, 1000));

if (!grid) { console.log("⚠ no fresh grid query captured (report may be on a summary page). Try opening ISA Detail Report tab."); process.exit(2); }
console.log("✓ captured fresh grid query with live headers");

// Strip Store IN ['1458'] from the Where clause.
let body = JSON.parse(grid.body);
function strip(o) {
  if (Array.isArray(o)) return o.filter((el) => {
    const s = JSON.stringify(el);
    return !(s.includes('"Property":"Store"') && s.includes("1458"));
  }).map(strip);
  if (o && typeof o === "object") { for (const k of Object.keys(o)) o[k] = strip(o[k]); }
  return o;
}
body = strip(body);

const headers = { ...grid.headers };
const res = await page.evaluate(async (url, hdrs, bodyStr) => {
  try {
    const resp = await fetch(url, { method: "POST", credentials: "include", headers: hdrs, body: bodyStr });
    const text = await resp.text();
    return { status: resp.status, len: text.length, text: text.slice(0, 3_000_000) };
  } catch (e) { return { error: String(e) }; }
}, grid.url, headers, JSON.stringify(body));

console.log("replay status:", res.status, "len:", res.len, "err:", res.error || "none");
if (res.text) {
  // Region/Market codes appear as string literals in DSR value arrays ("R":"12" style
  // varies; just harvest 1-3 digit codes near hierarchy). Do a broad scan of value tuples.
  const codes = [...res.text.matchAll(/"([0-9]{1,3})"/g)].map((m) => m[1]);
  const freq = {};
  for (const c of codes) freq[c] = (freq[c] || 0) + 1;
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 40);
  console.log("distinct short numeric codes in response (code:count):");
  console.log(top.map(([c, n]) => `${c}:${n}`).join("  "));
  const hasR4 = res.text.includes('"4"') || /Region[^]{0,20}\b4\b/.test(res.text);
  const hasM29 = res.text.includes('"29"');
  console.log(`contains "4": ${res.text.includes('"4"')}   contains "29": ${hasM29}`);
}
writeFileSync("rls-live-probe.json", JSON.stringify(res, null, 2));
console.log("✓ full response → dev/rls-live-probe.json");
browser.disconnect();
process.exit(0);
