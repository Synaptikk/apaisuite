// dev/probe-hoops-cvp.mjs
//
// Investigate https://hoops.wal-mart.com/report-hub/dashboard/cvp-performance-mkt
// to find the underlying data endpoint for the "Sell Through" metric.
//
// Strategy:
//   1. Open the dashboard URL in attached Edge
//   2. Capture every XHR/fetch fired during page load + first interactions
//   3. Surface anything that returns JSON related to "sell through" /
//      "cvp" / store-level performance data
//
// Output: dev/hoops-probe.json (full request capture) + console summary
// of the most promising endpoints.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const URL = "https://hoops.wal-mart.com/report-hub/dashboard/cvp-performance-mkt";

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
    reqHeaders: e.request.headers,
    reqBody:    e.request.postData ?? null,
    status:     null,
    respHeaders: null,
    respBody:   null,
    ts:         e.timestamp,
  });
});
cdp.on("Network.responseReceived", (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  r.status      = e.response.status;
  r.respHeaders = e.response.headers;
  r.mimeType    = e.response.mimeType;
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r || !/json|text|javascript|xml/.test(r.mimeType || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 12000)
      : (body.body || "").slice(0, 12000);
  } catch (e) {
    r.respBody = `[getResponseBody failed: ${e.message}]`;
  }
});

console.log(`→ navigating to ${URL}…`);
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
} catch (e) {
  console.log(`  navigate finished with timeout/redirect: ${e.message}`);
}
console.log(`  final URL: ${page.url()}`);

// Wait a bit for late-loading dashboard widgets to fire their XHRs.
await new Promise((r) => setTimeout(r, 8000));

// Take a screenshot so we can see the dashboard visually.
try {
  await page.screenshot({ path: "hoops-screenshot.png", fullPage: true });
  console.log(`  ✓ screenshot → hoops-screenshot.png`);
} catch (e) {
  console.log(`  screenshot failed: ${e.message}`);
}

// Look for "sell through" text on the page to confirm we're on the right view.
const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "");
const sawSellThrough = /sell.?through/i.test(pageText);
console.log(`  page contains "sell through": ${sawSellThrough}`);

// Filter relevant requests: XHR/Fetch, returning JSON, not generic platform noise
const apis = captured.filter((r) =>
  (r.type === "XHR" || r.type === "Fetch") &&
  /json/i.test(r.mimeType || "") &&
  !/insights|telemetry|amplitude|sentry|adobe|omtrdc|googletagmanager|analytics/i.test(r.url)
);

console.log(`\n=== ${apis.length} JSON XHR/Fetch requests captured ===`);
for (const r of apis) {
  const hit = r.respBody && /sell.?through|sellThrough|cvp|disposition/i.test(r.respBody);
  console.log(`${hit ? "★" : "  "} ${r.method} ${r.url}`);
  console.log(`    status=${r.status}  mime=${r.mimeType}  bodyLen=${(r.respBody || "").length}`);
  if (r.reqBody) console.log(`    REQ: ${String(r.reqBody).slice(0, 300)}`);
  if (hit) console.log(`    RES preview: ${String(r.respBody).slice(0, 600)}`);
}

writeFileSync("hoops-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/hoops-probe.json`);
browser.disconnect();
process.exit(0);
