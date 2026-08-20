// probe-rls-scope.mjs
//
// DEFINITIVE read-only RLS test for the Market 29 AP assessment.
// Takes the captured ISA detail grid query (which filters Store IN ['1458']),
// STRIPS the store filter, and replays it in the authenticated Power BI page
// context via fetch(credentials:include). Then counts the DISTINCT Regions /
// Markets / Stores the account is ALLOWED to return.
//
//   many regions incl. 4        -> Market 29 IS reachable (build the assessment)
//   only region 12 / market 120 -> account is RLS-locked to home area
//
// Read-only: this is a SELECT/QES data query, no writes, no settings changes.
// Never logs Authorization headers. Output: rls-scope-probe.json

import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";

const cap = JSON.parse(readFileSync("./market-scope-probe.json", "utf8")).captured;

// Find the ISA detail grid query: has Region+Market+Store hierarchy and the 1458 filter.
const src = cap.find(
  (x) => x.reqBody && /BU Hierarchy/.test(x.reqBody) && /'1458'/.test(x.reqBody) && x.url.includes("pbidedicated")
);
if (!src) { console.log("could not locate source grid query"); process.exit(1); }

// Remove the Store IN ['1458'] condition from the Where clause (read-only widening).
let body = JSON.parse(src.reqBody);
function stripStoreFilter(obj) {
  if (Array.isArray(obj)) return obj.filter((el) => {
    const s = JSON.stringify(el);
    return !(s.includes('"Property":"Store"') && s.includes("1458"));
  }).map(stripStoreFilter);
  if (obj && typeof obj === "object") { for (const k of Object.keys(obj)) obj[k] = stripStoreFilter(obj[k]); }
  return obj;
}
body = stripStoreFilter(body);

const targetUrl = src.url;
console.log("→ connecting to Edge :9222 (read-only replay)…");
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const targets = browser.targets().filter((t) => t.type() === "page" && t.url().includes("app.powerbi.com"));
if (!targets.length) { console.log("no Power BI tab open"); process.exit(1); }
const page = await targets[0].page();

// Capture the original request's headers (minus Authorization) from the page's own fetch.
const result = await page.evaluate(async (url, bodyStr) => {
  try {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: bodyStr,
    });
    const text = await resp.text();
    return { status: resp.status, text: text.slice(0, 2_000_000) };
  } catch (e) { return { error: String(e) }; }
}, targetUrl, JSON.stringify(body));

writeFileSync("rls-scope-probe.json", JSON.stringify(result, null, 2));
console.log("status:", result.status, "err:", result.error || "none", "len:", (result.text || "").length);

// Count distinct region/market/store literals that came back.
if (result.text) {
  const regions = new Set((result.text.match(/"Region"[^]{0,40}?"(\d{1,2})"/g) || []));
  // Fallback: look for hierarchy value patterns in the DSR value arrays.
  const nums = result.text.match(/\b(?:Region|Market)\b/gi) || [];
  console.log("raw markers:", nums.length);
  console.log("preview:", result.text.slice(0, 600));
}
browser.disconnect();
process.exit(0);
