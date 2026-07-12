// dev/probe-accident-evidence-v3.mjs
//
// Probe v3 of one.walmart.com accident-charge-summary. v1 missed the
// Go input; v2 located it but the session expired before submit. This
// run:
//   - Pre-warms one.walmart.com so the user has a fresh session
//   - Locates the visible Go input (input[type=submit/button] near a
//     store/facility input) and the store-input field
//   - Fills 1458, clicks Go, waits a long time for whatever rendering
//     pattern fires
//   - Captures EVERY request (Document, XHR, Fetch, Sub_frame, Script)
//     so we see if data lands via HTML embed, JSON XHR, or iframe load
//
// Output: dev/accident-v3-probe.json + screenshots before/after submit.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const URL = "https://one.walmart.com/content/uswire/en_us/work1/operations/enterprise-safety-hub/accident-prevention/administrative-safety-management-standards/accident-charge-summary.html";
const STORE = "1458";
const SAFE_LIMIT = 60000;

const EVIDENCE_MARKERS = /reference\s*nbr|claimant|evidence\s*status|customer\s*statement|witness\s*statement|bodily\s*injury|garage\s*keeper|tracking\s*#?/i;

console.log(`→ connecting to Edge…`);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// Reuse an existing one.walmart.com tab if open (likely fresh session).
const existingTarget = browser.targets().find((t) =>
  t.type() === "page" && /one\.walmart\.com/.test(t.url()) && !/login|sso/i.test(t.url())
);
let page;
if (existingTarget) {
  console.log(`✓ reusing existing one.walmart.com tab: ${existingTarget.url().slice(0, 80)}`);
  page = await existingTarget.page();
} else {
  console.log(`→ no existing tab; opening fresh`);
  page = await browser.newPage();
}
await page.setViewport({ width: 1700, height: 1100 });

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  // Skip noise — fonts, images, telemetry
  if (/\.woff|\.png|\.jpg|\.svg|\.gif|\.css|adobedtm|omtrdc|analytics|telemetry|appdynamics/i.test(e.request.url)) return;
  captured.push({
    requestId:    e.requestId,
    url:          e.request.url,
    method:       e.request.method,
    type:         e.type,
    reqHeaderNames: Object.keys(e.request.headers || {}),
    reqBody:      e.request.postData ?? null,
    status:       null,
    mimeType:     null,
    respBody:     null,
    frameId:      e.frameId,
    initiator:    e.initiator?.type,
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
  if (!r || !/json|text|javascript|xml|html/.test(r.mimeType || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 40000)
      : (body.body || "").slice(0, 40000);
  } catch {}
});

console.log(`→ navigating to ${URL}…`);
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: SAFE_LIMIT });
} catch (e) {
  console.log(`  navigate finished with: ${e.message}`);
}
const final1 = page.url();
console.log(`  final URL: ${final1}`);

// Check for SAML
if (/pfedprod|startSSO|saml/i.test(final1)) {
  console.warn(`  ✗ landed on SSO — session expired. Manually open the URL and re-auth.`);
  writeFileSync("accident-v3-probe.json", JSON.stringify(captured, null, 2));
  await page.screenshot({ path: "accident-v3-saml-redirect.png", fullPage: true }).catch(() => {});
  browser.disconnect();
  process.exit(0);
}

await new Promise((r) => setTimeout(r, 6000));
await page.screenshot({ path: "accident-v3-1-loaded.png", fullPage: true }).catch(() => {});

// Probe: find ALL visible inputs + their context, and ALL buttons.
const inputsSnapshot = await page.evaluate(() => {
  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== "BODY") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const out = { inputs: [], buttons: [] };
  for (const el of document.querySelectorAll("input")) {
    if (!isVisible(el)) continue;
    const label = el.closest("label")?.textContent?.trim()
               || el.getAttribute("aria-label")
               || el.getAttribute("placeholder")
               || el.parentElement?.previousElementSibling?.textContent?.trim()
               || "";
    out.inputs.push({
      id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, value: el.value,
      label: (label || "").slice(0, 80),
      x: Math.round(el.getBoundingClientRect().x),
      y: Math.round(el.getBoundingClientRect().y),
    });
  }
  for (const el of document.querySelectorAll("button, input[type=submit], input[type=button], a[role=button]")) {
    if (!isVisible(el)) continue;
    out.buttons.push({
      tag: el.tagName, type: el.type || "",
      id: el.id, name: el.name,
      text: ((el.textContent || el.value || "") + "").trim().slice(0, 80),
      x: Math.round(el.getBoundingClientRect().x),
      y: Math.round(el.getBoundingClientRect().y),
    });
  }
  return out;
});
console.log(`\n  ${inputsSnapshot.inputs.length} visible inputs:`);
for (const i of inputsSnapshot.inputs) {
  console.log(`    [${i.x},${i.y}] ${i.type} id="${i.id}" name="${i.name}" pl="${i.placeholder}" label="${i.label}" val="${i.value}"`);
}
console.log(`  ${inputsSnapshot.buttons.length} visible buttons:`);
for (const b of inputsSnapshot.buttons) {
  console.log(`    [${b.x},${b.y}] ${b.tag}[${b.type}] id="${b.id}" name="${b.name}" "${b.text}"`);
}

// Look for an input that's a sibling/near "Store" or "Facility" text on the page
const storeInputProbe = await page.evaluate(() => {
  const allText = Array.from(document.querySelectorAll("label, span, div, td, th, p"))
    .filter((el) => el.offsetParent && /^(store|facility|building|enter\s*facility|store\s*nbr)/i.test((el.textContent || "").trim()))
    .map((el) => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 60), x: el.getBoundingClientRect().x | 0, y: el.getBoundingClientRect().y | 0 }));
  return allText.slice(0, 10);
});
console.log(`\n  Store/facility label elements (${storeInputProbe.length}):`);
for (const t of storeInputProbe) console.log(`    [${t.x},${t.y}] <${t.tag}> "${t.text}"`);

// Pick the most plausible store input: a text/number input near "Store" or "Facility" text,
// or an input with placeholder hinting at facility.
const submitResult = await page.evaluate(async (store) => {
  const isVis = (el) => el.offsetParent && el.getBoundingClientRect().width > 0;

  // Direct: #myInput is the known facility input on this page (confirmed
  // visible at [873,329] with placeholder/value "Enter Facility or Market #").
  let storeInput = document.querySelector("#myInput");
  if (!storeInput || !isVis(storeInput)) {
    // Fallback heuristics
    storeInput = Array.from(document.querySelectorAll("input[type=text], input:not([type])"))
      .filter(isVis)
      .find((el) => /facility|store|building/i.test((el.value || "") + " " + (el.placeholder || "")));
  }
  if (!storeInput) return { ok: false, reason: "no store input found" };
  storeInput.focus();
  storeInput.value = store;
  storeInput.dispatchEvent(new Event("input", { bubbles: true }));
  storeInput.dispatchEvent(new Event("change", { bubbles: true }));

  // Go submit input — within 200px of the store input
  const sirect = storeInput.getBoundingClientRect();
  const submits = Array.from(document.querySelectorAll("input[type=submit], input[type=button], button"))
    .filter(isVis)
    .filter((b) => /^(go|submit|search|view|enter)$/i.test((b.value || b.textContent || "").trim()));
  let go = submits.find((b) => {
    const r = b.getBoundingClientRect();
    return Math.abs(r.y - sirect.y) < 100 && Math.abs(r.x - sirect.x) < 400;
  });
  if (!go) go = submits[0];
  if (!go) return { ok: false, reason: "no Go button", inputId: storeInput.id, inputValue: storeInput.value };

  go.click();
  return { ok: true, inputId: storeInput.id, inputValue: storeInput.value, buttonText: (go.value || go.textContent).trim() };
}, STORE);
console.log(`\n  submit attempt:`, submitResult);

// Wait LONG for response (could be AJAX, server-render, or iframe load)
console.log(`  waiting 25s for response…`);
await new Promise((r) => setTimeout(r, 25000));

await page.screenshot({ path: "accident-v3-2-after-submit.png", fullPage: true }).catch(() => {});

// Check what's on the page now
const afterText = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");
const sawEvidence = EVIDENCE_MARKERS.test(afterText);
console.log(`  page after submit contains evidence markers: ${sawEvidence}`);
if (sawEvidence) {
  const idx = afterText.search(EVIDENCE_MARKERS);
  console.log(`  context around match: ${afterText.slice(Math.max(0, idx - 40), idx + 200).replace(/\n/g, " ")}`);
}

// Show iframes after
const iframesAfter = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("iframe")).filter((f) => f.offsetParent).map((f) => ({
    src: (f.src || "").slice(0, 200),
    id: f.id, name: f.name,
    w: f.offsetWidth, h: f.offsetHeight,
  }));
});
console.log(`  iframes after submit (${iframesAfter.length}):`);
for (const f of iframesAfter) console.log(`    ${f.w}x${f.h} id="${f.id}" src=${f.src}`);

// Highlight responses likely carrying evidence data
const relevant = captured.filter((r) =>
  (r.respBody && EVIDENCE_MARKERS.test(r.respBody)) ||
  /claim|evidence|charge.?summary|enhanced.?export|bodily|garage/i.test(r.url)
);
console.log(`\n=== ${relevant.length} potentially-relevant requests ===`);
for (const r of relevant) {
  const star = r.respBody && EVIDENCE_MARKERS.test(r.respBody) ? "★" : "  ";
  console.log(`${star} ${r.method} ${r.url.slice(0, 130)}`);
  console.log(`    status=${r.status} mime=${r.mimeType} bodyLen=${(r.respBody || "").length}`);
  if (r.reqBody && r.reqBody.length < 400) console.log(`    REQ: ${r.reqBody.slice(0, 400)}`);
  if (r.respBody && EVIDENCE_MARKERS.test(r.respBody)) {
    const idx = r.respBody.search(EVIDENCE_MARKERS);
    console.log(`    RES context: ${r.respBody.slice(Math.max(0, idx - 60), idx + 600).replace(/\s+/g, " ")}`);
  }
}

writeFileSync("accident-v3-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/accident-v3-probe.json`);

browser.disconnect();
process.exit(0);
