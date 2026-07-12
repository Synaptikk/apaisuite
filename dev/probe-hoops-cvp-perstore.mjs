// dev/probe-hoops-cvp-perstore.mjs
//
// Probe https://hoops.wal-mart.com/ops-portal/metrics/cvp?bu=1458&buType=6&timeType=202
// to confirm the per-store GraphQL query shape. Builds on the market-level
// finding in dev/HOOPS_FINDINGS.md.
//
// Goals:
//   1. Capture every XHR/Fetch the per-store CVP page fires
//   2. Identify the GraphQL request(s) that drive the visible metrics
//   3. Confirm whether storeNbr={eq:1458} is the right filter shape, or
//      if Hoops uses something else (e.g., buId / buNbr)
//   4. Decode timeType=202 if it appears in the query body
//
// Output: dev/hoops-perstore-probe.json + console summary.
// NEVER logs cookies or auth values — only header names and counts.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const URL = "https://hoops.wal-mart.com/ops-portal/metrics/cvp?bu=1458&buType=6&timeType=202";

console.log(`→ connecting to Edge…`);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100 });

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  captured.push({
    requestId:  e.requestId,
    url:        e.request.url,
    method:     e.request.method,
    type:       e.type,
    // sanitize: keep header NAMES, drop values for sensitive ones
    reqHeaderNames: Object.keys(e.request.headers || {}),
    reqBody:    e.request.postData ?? null,
    status:     null,
    mimeType:   null,
    respBody:   null,
    ts:         e.timestamp,
  });
});
cdp.on("Network.responseReceived", (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  r.status   = e.response.status;
  r.mimeType = e.response.mimeType;
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r || !/json|text|javascript/.test(r.mimeType || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 16000)
      : (body.body || "").slice(0, 16000);
  } catch {}
});

console.log(`→ navigating to ${URL}…`);
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
} catch (e) {
  console.log(`  navigate finished with timeout/redirect: ${e.message}`);
}
console.log(`  final URL: ${page.url()}`);

await new Promise((r) => setTimeout(r, 8000));

try {
  await page.screenshot({ path: "hoops-perstore-screenshot.png", fullPage: true });
  console.log(`  ✓ screenshot → hoops-perstore-screenshot.png`);
} catch (e) {
  console.log(`  screenshot failed: ${e.message}`);
}

// Look for "sell through" / "CVP" text on the page
const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "");
const sawSellThrough = /sell.?through|cvp/i.test(pageText);
console.log(`  page contains CVP/sell-through markers: ${sawSellThrough}`);

const graphql = captured.filter((r) =>
  /graphql/i.test(r.url) || (r.reqBody && /\bquery\b/.test(r.reqBody))
);
const apis = captured.filter((r) =>
  (r.type === "XHR" || r.type === "Fetch") &&
  /json/i.test(r.mimeType || "") &&
  !/insights|telemetry|amplitude|sentry|adobe|omtrdc|googletagmanager|analytics/i.test(r.url)
);

console.log(`\n=== ${graphql.length} GraphQL-shaped requests ===`);
for (const r of graphql) {
  console.log(`  ${r.method} ${r.url}  status=${r.status}  mime=${r.mimeType}`);
  if (r.reqBody) {
    // Show a truncated, sanitized version of the request body
    console.log(`    REQ (first 800 chars): ${r.reqBody.slice(0, 800)}`);
  }
  if (r.respBody) {
    const sample = r.respBody.slice(0, 600);
    console.log(`    RES (first 600 chars): ${sample}`);
  }
}

console.log(`\n=== ${apis.length} JSON XHR/Fetch responses overall ===`);
for (const r of apis) {
  const hit = r.respBody && /sellThrough|cvpSales|cvpTotal|1458/i.test(r.respBody);
  console.log(`${hit ? "★" : "  "} ${r.method} ${r.url}`);
  console.log(`    status=${r.status}  bodyLen=${(r.respBody || "").length}`);
}

writeFileSync("hoops-perstore-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/hoops-perstore-probe.json`);

await page.close().catch(() => {});
browser.disconnect();
process.exit(0);
