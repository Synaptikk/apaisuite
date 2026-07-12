// dev/probe-directory.mjs
//
// One-off: attach to running Edge (must be launched with
// --remote-debugging-port=9222 via launch-edge-debug.sh), open the Walmart
// people directory, search a known username, and dump every XHR/Fetch the
// page fires + the full response body of the one that returned the match.
//
// Output goes to stdout AND dev/directory-probe.json so we can grep through
// it offline. This is exploratory tooling — once we know the endpoint,
// modules/claimsdisposition/lib/userDirectory.js gets wired up and this
// script can be deleted.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const TARGET_URL  = "https://one.walmart.com/content/uswire/en_us/directory.html";
const QUERY       = process.argv[2] || "ses008s";   // override: node probe-directory.mjs <username>
const OUT_FILE    = "directory-probe.json";

console.log(`→ Connecting to ${BROWSER_URL}…`);
const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
console.log(`✓ Connected`);

console.log(`→ Opening ${TARGET_URL}…`);
const page = await browser.newPage();

// Capture every network request fired by the page. Many directory pages
// fire on input — we want to see all of them. Store request + response
// metadata; resolve bodies after the response settles.
const captured = [];   // {requestId, url, method, status, type, reqHeaders, reqBody, respHeaders, respBody}
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");

cdp.on("Network.requestWillBeSent", (e) => {
  captured.push({
    requestId:   e.requestId,
    url:         e.request.url,
    method:      e.request.method,
    type:        e.type,
    reqHeaders:  e.request.headers,
    reqBody:     e.request.postData ?? null,
    status:      null,
    respHeaders: null,
    respBody:    null,
    ts:          e.timestamp,
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
  if (!r) return;
  // Only bother fetching bodies for interesting MIME types (json, text).
  // Skip images/fonts/css/etc to keep the dump small.
  if (!/json|text|javascript|xml/.test(r.mimeType || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 8192)
      : (body.body || "").slice(0, 8192);
  } catch (e) {
    r.respBody = `[getResponseBody failed: ${e.message}]`;
  }
});

await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 30000 });
console.log(`✓ Page loaded — URL is now ${page.url()}`);

// Give the page a beat to settle (some SPAs continue fetching after networkidle).
await new Promise((r) => setTimeout(r, 1500));

// Find a search input. The directory page likely has an <input> for the
// query. We try a few plausible selectors; if none match, we dump the
// page's input/form elements so the user can tell us which one.
console.log(`→ Looking for a search box…`);
const probedFields = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input, textarea")];
  return inputs.map((el) => ({
    tag: el.tagName,
    type: el.type || null,
    name: el.name || null,
    id: el.id || null,
    placeholder: el.placeholder || null,
    ariaLabel: el.getAttribute("aria-label") || null,
    visible: el.offsetParent !== null,
  })).slice(0, 40);
});
console.log(`  found ${probedFields.length} input/textarea elements:`);
for (const f of probedFields.slice(0, 15)) {
  console.log(`    ${f.tag} type=${f.type} id=${f.id || "-"} name=${f.name || "-"} ph="${f.placeholder || ""}" aria="${f.ariaLabel || ""}" vis=${f.visible}`);
}

// Best-effort: pick the most search-looking input.
const searchSelectors = [
  'input[type="search"]',
  'input[placeholder*="earch" i]',
  'input[aria-label*="earch" i]',
  'input[name*="search" i]',
  'input[id*="search" i]',
  'input[placeholder*="name" i]',
  'input[type="text"]',
];
let searchSel = null;
for (const sel of searchSelectors) {
  const exists = await page.$(sel);
  if (exists) { searchSel = sel; break; }
}
if (!searchSel) {
  console.log(`✗ Couldn't find a search input. See the list above and tell me which selector to use.`);
} else {
  console.log(`✓ Using selector: ${searchSel}`);
  console.log(`→ Typing "${QUERY}" into the search box…`);
  // Clear captured BEFORE typing so we only see the search XHRs (not page load chatter).
  const cutoff = captured.length;
  console.log(`  (snapshot cutoff at ${cutoff} requests — capture from here on)`);

  await page.click(searchSel, { clickCount: 3 }).catch(() => {});
  await page.type(searchSel, QUERY, { delay: 70 });
  // Press Enter in case it's the submit trigger.
  await page.keyboard.press("Enter").catch(() => {});

  // Wait for any subsequent XHRs to settle.
  await new Promise((r) => setTimeout(r, 4000));

  const searchReqs = captured.slice(cutoff).filter((r) => r.type === "XHR" || r.type === "Fetch");
  console.log(`\n========== XHR / Fetch fired during search ==========`);
  console.log(`  ${searchReqs.length} request(s)`);
  for (const r of searchReqs) {
    console.log(`\n  ${r.method} ${r.url}`);
    console.log(`    status:    ${r.status}`);
    console.log(`    mime:      ${r.mimeType}`);
    if (r.reqBody) console.log(`    reqBody:   ${r.reqBody.slice(0, 300)}`);
    if (r.respBody) {
      const preview = r.respBody.slice(0, 500);
      console.log(`    respBody:  ${preview}${r.respBody.length > 500 ? "…" : ""}`);
    }
  }
}

writeFileSync(OUT_FILE, JSON.stringify(captured, null, 2));
console.log(`\n✓ Wrote ${captured.length} captured requests → ${OUT_FILE}`);

// Don't close the page — leave it for inspection.
browser.disconnect();
process.exit(0);
