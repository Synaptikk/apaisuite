// dev/probe-register-powerbi.mjs
//
// Probe the register long/short Power BI report. Captures every QES
// (QueryExecutionService) POST while the report loads, identifies the
// data-grid query, dumps its body + response so we can build a matcher
// in the content script.
//
// Output: dev/register-powerbi-probe.json + console summary.
// Sensitive-value policy: never log Authorization values, only header
// names + sanitized bodies.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const REPORT_URL = "https://app.powerbi.com/groups/me/reports/65c97d6a-7ad8-498d-b752-69028d408993/ReportSection?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi";

console.log(`→ connecting to Edge…`);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// Try to find an existing tab on the register report first
const existingTargets = browser.targets().filter((t) =>
  t.type() === "page" && /app\.powerbi\.com.*65c97d6a/.test(t.url())
);
let page;
if (existingTargets.length) {
  console.log(`✓ found existing tab on register report: ${existingTargets[0].url().slice(0, 100)}`);
  page = await existingTargets[0].page();
} else {
  console.log(`→ no existing tab; opening report in new tab…`);
  page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
}

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  // Skip non-QES traffic (telemetry, fonts, etc.) to keep the dump small.
  const url = e.request.url;
  if (!/QueryExecutionService|pbidedicated/i.test(url)) return;
  captured.push({
    requestId:    e.requestId,
    url,
    method:       e.request.method,
    type:         e.type,
    reqHeaderNames: Object.keys(e.request.headers || {}),
    reqBody:      e.request.postData ?? null,
    status:       null,
    mimeType:     null,
    respBody:     null,
    ts:           e.timestamp,
  });
});
cdp.on("Network.responseReceived", (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  r.status = e.response.status;
  r.mimeType = e.response.mimeType;
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 40000)
      : (body.body || "").slice(0, 40000);
  } catch {}
});

if (!existingTargets.length) {
  console.log(`→ navigating to ${REPORT_URL}…`);
  try {
    await page.goto(REPORT_URL, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e) {
    console.log(`  navigate finished with: ${e.message}`);
  }
  console.log(`  final URL: ${page.url()}`);
} else {
  console.log(`  current URL: ${page.url()}`);
  // Soft reload to make sure we capture queries
  try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); }
  catch (e) { console.log(`  reload finished with: ${e.message}`); }
}

console.log(`→ waiting 18s for report to render + fire its dataset queries…`);
await new Promise((r) => setTimeout(r, 18_000));

try {
  await page.screenshot({ path: "register-powerbi-screenshot.png", fullPage: false });
  console.log(`  📸 register-powerbi-screenshot.png`);
} catch (e) { console.log(`  screenshot failed: ${e.message}`); }

// Sanitize for output: drop Authorization values from headers (we record
// names only at capture time, so this is just defense in depth).
console.log(`\n=== ${captured.length} QES-related requests captured ===`);
for (const r of captured.slice(0, 60)) {
  const isQuery = /\/query\b/i.test(r.url);
  const looksRegister = r.reqBody && /"Register"|"Reg"|"RegisterNbr"|"reg_nbr"|"Operator"|"Date"/i.test(r.reqBody);
  const tag = isQuery ? (looksRegister ? "★REG" : "qry") : "   ";
  console.log(`${tag} ${r.method} ${r.url.slice(0, 80)}…  status=${r.status}  bodyLen=${(r.reqBody || "").length}/${(r.respBody || "").length}`);
}

const registerQueries = captured.filter((r) =>
  /\/query\b/i.test(r.url) &&
  r.reqBody && /"Register"|"Reg"|"RegisterNbr"|"reg_nbr"/i.test(r.reqBody)
);
console.log(`\n=== ${registerQueries.length} requests appear to be the REGISTER grid query ===`);
for (const r of registerQueries) {
  console.log(`---`);
  console.log(`URL: ${r.url.slice(0, 160)}`);
  console.log(`REQ BODY (first 2500 chars):`);
  console.log((r.reqBody || "").slice(0, 2500));
  console.log(`RES BODY (first 1500 chars):`);
  console.log((r.respBody || "").slice(0, 1500));
  console.log(`---`);
}

writeFileSync("register-powerbi-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/register-powerbi-probe.json`);

// Don't close — the user has the tab open
browser.disconnect();
process.exit(0);
