// dev/probe-accident-evidence-v2.mjs
//
// Second probe of one.walmart.com accident-charge-summary, now with:
//   - Iframe detection (recursive, on initial load + after each click)
//   - All MANAGE / Search / Go button enumeration + click attempts
//   - Longer wait window (60s after initial load)
//   - Capture of all sub-frame URLs and any storage.googleapis.com hits
//
// Output: dev/accident-evidence-v2-probe.json + screenshots.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const URL = "https://one.walmart.com/content/uswire/en_us/work1/operations/enterprise-safety-hub/accident-prevention/administrative-safety-management-standards/accident-charge-summary.html";
const STORE = "1458";

const EVIDENCE_MARKERS = /reference\s*nbr|claimant|evidence\s*status|customer\s*statement|witness\s*statement|bodily\s*injury|garage\s*keeper|tracking/i;
const STORE_INPUT_HINTS = /(facility|building|store|location|market)/i;

console.log(`→ connecting to Edge…`);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100 });

const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  captured.push({
    requestId:   e.requestId,
    url:         e.request.url,
    method:      e.request.method,
    type:        e.type,
    reqHeaderNames: Object.keys(e.request.headers || {}),
    reqBody:     e.request.postData ?? null,
    status:      null, mimeType: null, respBody: null,
    frameId:     e.frameId,
    initiator:   e.initiator?.type,
    ts:          e.timestamp,
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
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 24000)
      : (body.body || "").slice(0, 24000);
  } catch {}
});

console.log(`→ navigating to ${URL}…`);
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
} catch (e) {
  console.log(`  navigate finished with timeout: ${e.message}`);
}
console.log(`  final URL: ${page.url()}`);

await new Promise((r) => setTimeout(r, 5000));

// Wave 1: scan iframes
async function scanIframes() {
  return await page.evaluate(() => {
    function collect(root, depth = 0) {
      const out = [];
      const frames = root.querySelectorAll("iframe");
      for (const f of frames) {
        out.push({
          depth,
          src:    f.src || "",
          name:   f.name || "",
          id:     f.id || "",
          width:  f.offsetWidth, height: f.offsetHeight,
          visible: f.offsetParent !== null,
        });
      }
      return out;
    }
    return collect(document);
  });
}
let iframes = await scanIframes();
console.log(`  initial iframes (${iframes.length}):`);
for (const f of iframes) console.log(`    depth=${f.depth} ${f.visible ? "visible" : "hidden"} ${f.width}x${f.height}  src=${f.src.slice(0, 120)} id=${f.id}`);
await page.screenshot({ path: "accident-v2-1-initial.png", fullPage: true }).catch(() => {});

// Wave 2: enumerate ALL clickable elements (button/anchor/input with click behavior)
const clickables = await page.evaluate(() => {
  const out = [];
  const els = Array.from(document.querySelectorAll("button, a, input[type=submit], input[type=button], [role=button]"));
  for (const el of els) {
    if (!el.offsetParent) continue;  // not visible
    const text = (el.textContent || el.value || "").trim();
    if (!text) continue;
    out.push({
      tag: el.tagName,
      text: text.slice(0, 80),
      id: el.id || "",
      cls: (el.className || "").toString().slice(0, 80),
      x: el.getBoundingClientRect().x | 0,
      y: el.getBoundingClientRect().y | 0,
    });
  }
  return out;
});
console.log(`  ${clickables.length} visible clickables:`);
const interesting = clickables.filter((c) => /go|search|find|view|manage|claim|report|safety|evidence|accident/i.test(c.text));
for (const c of interesting.slice(0, 20)) console.log(`    [${c.x},${c.y}] ${c.tag} "${c.text}"`);

// Wave 3: try clicking each MANAGE button (or anything looking like a launcher)
async function clickByText(text) {
  return await page.evaluate((txt) => {
    const els = Array.from(document.querySelectorAll("button, a, input[type=submit], input[type=button], [role=button]"));
    const target = els.find((el) => el.offsetParent && ((el.textContent || el.value || "").trim() === txt));
    if (!target) return { ok: false, reason: "not found" };
    target.click();
    return { ok: true, href: target.href || null };
  }, text);
}

const manageButtons = interesting.filter((c) => /^manage$/i.test(c.text));
console.log(`  ${manageButtons.length} MANAGE buttons to try`);

// Try clicking MANAGE buttons one at a time; check iframes after each
let foundFormFrame = null;
for (let i = 0; i < Math.min(manageButtons.length, 3); i++) {
  console.log(`  clicking MANAGE button #${i+1}…`);
  await clickByText("MANAGE");  // clicks first one (DOM order)
  await new Promise((r) => setTimeout(r, 4000));
  iframes = await scanIframes();
  const newFrame = iframes.find((f) => f.visible && f.src && !/cookie|consent|adobe|analytics/i.test(f.src));
  if (newFrame) {
    console.log(`    new visible iframe: ${newFrame.src.slice(0, 160)}`);
    foundFormFrame = newFrame;
    break;
  }
}

// Wave 4: try directly probing the page for any form inputs in iframes
const allFrames = page.frames();
console.log(`  page has ${allFrames.length} frames total:`);
for (const f of allFrames) {
  console.log(`    ${f.url().slice(0, 120)}`);
}

// For each non-main frame, look for store-input + Go pattern
for (const f of allFrames) {
  if (f === page.mainFrame()) continue;
  try {
    const probe = await f.evaluate((HINT_RE_STR) => {
      const HINT_RE = new RegExp(HINT_RE_STR, "i");
      const inputs = Array.from(document.querySelectorAll("input"));
      const found = inputs
        .filter((el) => el.offsetParent)
        .map((el) => ({
          id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
          matches: HINT_RE.test((el.id || "") + " " + (el.name || "") + " " + (el.placeholder || "")),
        }));
      const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a, [role=button]"))
        .filter((el) => el.offsetParent)
        .map((el) => (el.textContent || el.value || "").trim())
        .filter(Boolean);
      return { inputs: found.slice(0, 20), buttons: buttons.slice(0, 30), bodySnippet: document.body?.innerText?.slice(0, 800) || "" };
    }, STORE_INPUT_HINTS.source);
    console.log(`  frame ${f.url().slice(0, 80)}:`);
    for (const i of probe.inputs.filter((i) => i.matches)) console.log(`      ★ ${JSON.stringify(i)}`);
    if (probe.buttons.length) console.log(`      buttons: ${probe.buttons.slice(0, 10).join(" | ")}`);
    if (probe.bodySnippet) console.log(`      body: ${probe.bodySnippet.slice(0, 200).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`  frame ${f.url().slice(0, 60)}: probe failed (${e.message})`);
  }
}

await new Promise((r) => setTimeout(r, 8000));
await page.screenshot({ path: "accident-v2-2-after-clicks.png", fullPage: true }).catch(() => {});

// Wave 5: final network filter — look for CAS storage / claim-related URLs
const interestingReqs = captured.filter((r) =>
  /cas_storage|claim|evidence|charge.?summary|bodily|garage|enhanced.?export/i.test(r.url) ||
  (r.respBody && EVIDENCE_MARKERS.test(r.respBody))
);
console.log(`\n=== ${interestingReqs.length} potentially-relevant requests ===`);
for (const r of interestingReqs) {
  const hit = r.respBody && EVIDENCE_MARKERS.test(r.respBody);
  console.log(`${hit ? "★" : "  "} ${r.method} ${r.url.slice(0, 140)}`);
  console.log(`    status=${r.status} mime=${r.mimeType} bodyLen=${(r.respBody || "").length}`);
  if (r.reqBody && r.reqBody.length < 400) console.log(`    REQ: ${r.reqBody}`);
  if (hit) console.log(`    RES preview: ${r.respBody.slice(0, 700).replace(/\n/g, " ")}`);
}

writeFileSync("accident-evidence-v2-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full capture → dev/accident-evidence-v2-probe.json`);

await page.close().catch(() => {});
browser.disconnect();
process.exit(0);
