// dev/probe-enviance-compliance.mjs
//
// Probe the Enviance compliance task panel for facility 01458 to capture
// the underlying data endpoint and response shape.
//
// Strategy:
//   1. Open the URL in the attached Edge instance
//   2. Capture every XHR/Fetch fired during page load + first 10s of activity
//   3. Surface anything that returns JSON related to task names / due dates
//
// Output: dev/enviance-probe.json + console summary.
// NEVER logs cookie values — only header names.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const URL = "https://go.enviance.com/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/index.html?SystemID=774d2e17-a8fc-409f-9480-e3fa9310c1c5#/panel/cd2f57ae-5625-4762-8f88-1d47d915cc54/false";

const KNOWN_TASKS_MARKERS = /eyewash|hazwaste|SPCC|fire extinguisher|exit sign|security tour|safety assessment/i;

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
  if (!r || !/json|text|javascript|xml/.test(r.mimeType || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 24000)
      : (body.body || "").slice(0, 24000);
  } catch {}
});

console.log(`→ navigating to Enviance panel…`);
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
} catch (e) {
  console.log(`  navigate finished with timeout/redirect: ${e.message}`);
}
console.log(`  final URL: ${page.url()}`);

// Wait longer — the SPA may load data after networkidle
await new Promise((r) => setTimeout(r, 12000));

try {
  await page.screenshot({ path: "enviance-screenshot.png", fullPage: true });
  console.log(`  ✓ screenshot → enviance-screenshot.png`);
} catch (e) {
  console.log(`  screenshot failed: ${e.message}`);
}

const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "");
const sawKnownTask = KNOWN_TASKS_MARKERS.test(pageText);
const sawFacility = /1458|01458/.test(pageText);
console.log(`  page contains known task names: ${sawKnownTask}`);
console.log(`  page contains facility 1458: ${sawFacility}`);
console.log(`  page text first 500: ${pageText.slice(0, 500).replace(/\n/g, ' ')}`);

const apis = captured.filter((r) =>
  (r.type === "XHR" || r.type === "Fetch") &&
  !/insights|telemetry|amplitude|sentry|adobe|omtrdc|googletagmanager|analytics|fonts|favicon/i.test(r.url)
);

console.log(`\n=== ${apis.length} non-noise XHR/Fetch requests ===`);
for (const r of apis) {
  const hit = r.respBody && (KNOWN_TASKS_MARKERS.test(r.respBody) || /1458|01458/.test(r.respBody));
  console.log(`${hit ? "★" : "  "} ${r.method} ${r.url}`);
  console.log(`    status=${r.status}  mime=${r.mimeType}  bodyLen=${(r.respBody || "").length}`);
  if (r.reqBody) console.log(`    REQ: ${String(r.reqBody).slice(0, 400)}`);
  if (hit) console.log(`    RES preview: ${String(r.respBody).slice(0, 800)}`);
}

writeFileSync("enviance-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/enviance-probe.json`);

await page.close().catch(() => {});
browser.disconnect();
process.exit(0);
