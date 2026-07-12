// dev/probe-directory-form.mjs
//
// The directory.html page has a search form with a "Person" entity-type
// button and a "GoSearch" submit. The earlier probe used a heuristic
// selector that picked the wrong input. This script:
//   1. Navigates the directory page (auth completes)
//   2. Clicks the "Person" entity-type button
//   3. Fills the search input with a username
//   4. Submits via the GoSearch button
//   5. Captures every XHR fired during/after submission
//   6. Snapshots the result page

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const QUERY = process.argv[2] || "ses008s";
const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  captured.push({
    requestId: e.requestId, url: e.request.url, method: e.request.method,
    type: e.type, reqHeaders: e.request.headers, reqBody: e.request.postData ?? null,
    status: null, mimeType: null, respBody: null, ts: e.timestamp,
  });
});
cdp.on("Network.responseReceived", (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  r.status = e.response.status; r.mimeType = e.response.mimeType;
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r || !/json|text|javascript|xml/.test(r.mimeType || "")) return;
  try {
    const b = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = b.base64Encoded
      ? Buffer.from(b.body, "base64").toString("utf8").slice(0, 6000)
      : (b.body || "").slice(0, 6000);
  } catch {}
});

console.log("→ directory.html (auth-handshake)…");
await page.goto("https://one.walmart.com/content/uswire/en_us/directory.html", {
  waitUntil: "networkidle2", timeout: 30000,
});
await new Promise((r) => setTimeout(r, 2000));
console.log(`  ✓ final URL: ${page.url()}`);

// Find ALL buttons & inputs (visible) so we can see what's available.
const formStuff = await page.evaluate(() => {
  const r = { buttons: [], inputs: [], forms: [] };
  for (const el of document.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='radio'], input[type='checkbox']")) {
    if (!el.offsetParent && el.type !== "radio") continue;
    r.buttons.push({
      tag: el.tagName, type: el.type, id: el.id, name: el.name,
      value: el.value, text: (el.textContent || "").trim().slice(0,40),
      aria: el.getAttribute("aria-label"),
    });
  }
  for (const el of document.querySelectorAll("input[type='text'], input[type='search'], input:not([type])")) {
    if (!el.offsetParent) continue;
    r.inputs.push({
      tag: el.tagName, type: el.type, id: el.id, name: el.name,
      placeholder: el.placeholder, aria: el.getAttribute("aria-label"),
    });
  }
  for (const f of document.querySelectorAll("form")) {
    r.forms.push({ id: f.id, action: f.action, method: f.method });
  }
  return r;
});
console.log("Buttons:");
formStuff.buttons.forEach(b => console.log(`  ${b.tag} type=${b.type} id=${b.id||"-"} name=${b.name||"-"} value="${b.value||""}" text="${b.text}" aria="${b.aria||""}"`));
console.log("Inputs:");
formStuff.inputs.forEach(i => console.log(`  ${i.tag} type=${i.type} id=${i.id||"-"} name=${i.name||"-"} ph="${i.placeholder||""}" aria="${i.aria||""}"`));
console.log("Forms:");
formStuff.forms.forEach(f => console.log(`  id=${f.id||"-"} action=${f.action} method=${f.method}`));

const cutoff = captured.length;
console.log(`\n→ snapshot cutoff ${cutoff}. Selecting Person mode + searching "${QUERY}"…`);

// Try clicking the "Person" button (entity type) then typing into the first text input.
try {
  await page.evaluate(() => {
    const personBtn = [...document.querySelectorAll("button, input")].find((el) =>
      (el.value || el.textContent || "").trim() === "Person"
    );
    if (personBtn) personBtn.click();
  });
  console.log("  clicked Person");
} catch (e) { console.log(`  Person click err: ${e.message}`); }

await new Promise((r) => setTimeout(r, 800));

// Find the search text input — re-evaluate in case Person click changed the DOM
const searchInputs = await page.evaluate(() => {
  return [...document.querySelectorAll("input[type='text'], input[type='search'], input:not([type])")]
    .filter((el) => el.offsetParent)
    .map((el) => ({ id: el.id, name: el.name, placeholder: el.placeholder, aria: el.getAttribute("aria-label") }));
});
console.log("  text inputs after Person click:", searchInputs);

// Type into the first one
const firstInput = searchInputs[0];
if (firstInput) {
  const sel = firstInput.id ? `#${firstInput.id}` : (firstInput.name ? `input[name="${firstInput.name}"]` : "input[type='text']");
  console.log(`  typing into: ${sel}`);
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.type(sel, QUERY, { delay: 70 });
  // Submit via the GoSearch button rather than Enter
  await page.evaluate(() => {
    const goBtn = [...document.querySelectorAll("button, input")].find((el) =>
      /search/i.test(el.value || el.textContent || "") && (el.type === "submit" || el.tagName === "BUTTON")
    );
    if (goBtn) goBtn.click();
  });
  console.log("  clicked search button");
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(`✓ Final URL: ${page.url()}`);

const xhrs = captured.slice(cutoff).filter((r) => r.type === "XHR" || r.type === "Fetch" || r.type === "Document");
console.log(`\n========== ${xhrs.length} XHR/Fetch/Document after submit ==========`);
for (const r of xhrs) {
  console.log(`\n${r.method} ${r.url}`);
  console.log(`  status=${r.status}  mime=${r.mimeType}`);
  if (r.reqBody) console.log(`  REQ: ${String(r.reqBody).slice(0, 500)}`);
  if (r.respBody) {
    // Look specifically for the query string OR a name in the response
    const body = String(r.respBody);
    const hasQuery = body.toLowerCase().includes(QUERY.toLowerCase());
    const hasShane = /shane|smith/i.test(body);
    console.log(`  contains "${QUERY}"=${hasQuery}  contains "shane"=${hasShane}`);
    console.log(`  RES preview: ${body.slice(0, 600)}`);
  }
}

await page.screenshot({ path: "directory-form-result.png", fullPage: true });
writeFileSync("directory-form-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Screenshot → directory-form-result.png  Full → directory-form-probe.json`);
browser.disconnect();
process.exit(0);
