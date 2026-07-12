// dev/probe-accident-evidence.mjs
//
// Probe one.walmart.com accident-charge-summary page for store 1458.
// Determine whether data is delivered as embedded HTML, a JSON XHR after
// form submit, or something else.
//
// Strategy:
//   1. Open the URL in the attached Edge instance (user already signed in)
//   2. Capture initial page load network traffic
//   3. If page has a form, find the store-number input and Go button, submit
//   4. Capture more network traffic from the form submission
//   5. Surface anything containing claim references / evidence column names
//
// Output: dev/accident-evidence-probe.json + console summary.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const URL = "https://one.walmart.com/content/uswire/en_us/work1/operations/enterprise-safety-hub/accident-prevention/administrative-safety-management-standards/accident-charge-summary.html";
const STORE = "1458";

const EVIDENCE_MARKERS = /reference\s*nbr|claimant|evidence\s*status|customer\s*statement|witness\s*statement|bodily\s*injury|garage\s*keeper|tracking/i;

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
  if (!r || !/json|text|javascript|xml|html/.test(r.mimeType || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 30000)
      : (body.body || "").slice(0, 30000);
  } catch {}
});

console.log(`→ navigating to accident-charge-summary…`);
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
} catch (e) {
  console.log(`  navigate finished with timeout/redirect: ${e.message}`);
}
console.log(`  final URL: ${page.url()}`);

await new Promise((r) => setTimeout(r, 5000));

// Snapshot phase 1: initial load
await page.screenshot({ path: "accident-evidence-1-initial.png", fullPage: true }).catch(() => {});

// Scan for form inputs (store number + Go button)
const inputs = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll("input, select, button"));
  return all.slice(0, 40).map((el) => ({
    tag: el.tagName,
    type: el.type || "",
    id: el.id || "",
    name: el.name || "",
    placeholder: el.placeholder || "",
    label: (el.textContent || "").trim().slice(0, 80),
  }));
});
console.log(`  page has ${inputs.length} input/select/button elements:`);
for (const i of inputs.slice(0, 20)) {
  console.log(`    ${i.tag}[type=${i.type}] id="${i.id}" name="${i.name}" placeholder="${i.placeholder}" text="${i.label}"`);
}

// Try to find the store-number input and Go button heuristically
const submitResult = await page.evaluate(async (store) => {
  // Find input: likely id/name contains "store" or "facility"
  const inputs = Array.from(document.querySelectorAll("input"));
  let storeInput = inputs.find((el) =>
    /store|facility|building|location/i.test((el.id || "") + " " + (el.name || "") + " " + (el.placeholder || ""))
  );
  if (!storeInput) {
    // Fall back: any visible text input
    storeInput = inputs.find((el) => (el.type === "text" || !el.type) && el.offsetParent !== null);
  }
  if (!storeInput) return { ok: false, reason: "no input field found" };
  storeInput.value = store;
  storeInput.dispatchEvent(new Event("input", { bubbles: true }));
  storeInput.dispatchEvent(new Event("change", { bubbles: true }));

  // Find Go button
  const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a"));
  const go = buttons.find((b) => /^\s*(go|submit|search|find|view)\s*$/i.test((b.textContent || b.value || "").trim()));
  if (!go) return { ok: false, reason: "no Go/Submit button found", inputId: storeInput.id, inputName: storeInput.name };

  go.click();
  return { ok: true, inputId: storeInput.id, inputName: storeInput.name, buttonText: (go.textContent || go.value).trim() };
}, STORE);

console.log(`  form submit attempt:`, submitResult);

// Wait for form-submit traffic
await new Promise((r) => setTimeout(r, 10000));

await page.screenshot({ path: "accident-evidence-2-after-go.png", fullPage: true }).catch(() => {});

const pageText2 = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "");
const sawEvidence = EVIDENCE_MARKERS.test(pageText2);
console.log(`  page after submit contains evidence markers: ${sawEvidence}`);

const apis = captured.filter((r) =>
  (r.type === "XHR" || r.type === "Fetch" || r.type === "Document") &&
  !/insights|telemetry|amplitude|sentry|adobe|omtrdc|googletagmanager|analytics|fonts|favicon|\.png|\.jpg|\.svg|\.css/i.test(r.url)
);

console.log(`\n=== ${apis.length} non-noise requests ===`);
for (const r of apis) {
  const hit = r.respBody && (EVIDENCE_MARKERS.test(r.respBody) || /\b1458\b/.test(r.respBody));
  console.log(`${hit ? "★" : "  "} ${r.method} ${r.url}`);
  console.log(`    status=${r.status}  mime=${r.mimeType}  bodyLen=${(r.respBody || "").length}`);
  if (r.reqBody && r.reqBody.length < 800) console.log(`    REQ: ${r.reqBody}`);
  if (hit) console.log(`    RES preview: ${String(r.respBody).slice(0, 800)}`);
}

writeFileSync("accident-evidence-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/accident-evidence-probe.json`);

await page.close().catch(() => {});
browser.disconnect();
process.exit(0);
