// dev/probe-digitallocks-network.mjs
// Capture every XHR Power BI fires when the data visual loads, find the
// one carrying the lock-event rows, and dump its request body (DAX query)
// + response body so we can design a replay strategy.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }
await target.bringToFront();
await new Promise(r => setTimeout(r, 400));

const captured = [];
const cdp = await target.createCDPSession();
await cdp.send("Network.enable");

cdp.on("Network.requestWillBeSent", (e) => {
  // Filter to interesting endpoints early — drops images, fonts, etc.
  if (e.type === "Image" || e.type === "Font" || e.type === "Stylesheet" || e.type === "Media") return;
  captured.push({
    id: e.requestId,
    url: e.request.url,
    method: e.request.method,
    type: e.type,
    reqHeaders: e.request.headers,
    reqBody: e.request.postData ?? null,
    status: null,
    respHeaders: null,
    mime: null,
    respBody: null,
    ts: e.timestamp,
  });
});
cdp.on("Network.responseReceived", (e) => {
  const r = captured.find((x) => x.id === e.requestId);
  if (!r) return;
  r.status = e.response.status;
  r.respHeaders = e.response.headers;
  r.mime = e.response.mimeType;
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.id === e.requestId);
  if (!r) return;
  // Only pull response bodies for JSON-ish endpoints.
  if (!/json/i.test(r.mime || "")) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8").slice(0, 20000)
      : (body.body || "").slice(0, 20000);
  } catch (e) { /* sometimes the body is gone */ }
});

// Trigger a refresh to force the data XHR(s) to fire fresh.
console.log("→ clicking 'Refresh visuals' to force the data fetch…");
const clicked = await target.evaluate(() => {
  const btn = [...document.querySelectorAll('button[aria-label*="Refresh visuals" i]')]
    .find((b) => b.offsetParent !== null);
  if (!btn) return false;
  const r = btn.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 };
  btn.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse" }));
  btn.dispatchEvent(new MouseEvent("mousedown", o));
  btn.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse" }));
  btn.dispatchEvent(new MouseEvent("mouseup", o));
  btn.dispatchEvent(new MouseEvent("click", o));
  btn.click?.();
  return true;
});
console.log(`  Refresh click: ${clicked ? "OK" : "BUTTON NOT FOUND"}`);

// Wait for traffic to settle
console.log("→ waiting 12s for XHRs to land…");
await new Promise(r => setTimeout(r, 12000));

// Now classify what we got
const dataish = captured.filter((r) =>
  r.status === 200 &&
  r.method === "POST" &&
  (/querydata|conceptual|explore|querydata|queryData|public\/reports/i.test(r.url) || /json/i.test(r.mime || ""))
);

const everyPost = captured.filter((r) => r.method === "POST" && r.status === 200);

console.log(`\nTotal captured: ${captured.length}`);
console.log(`Successful POSTs: ${everyPost.length}`);
console.log(`Data-ish endpoints: ${dataish.length}`);

console.log("\n========== TOP POST CANDIDATES ==========");
for (const r of everyPost.slice(0, 20)) {
  console.log(`\n  ${r.method} ${r.url}`);
  console.log(`    mime=${r.mime}  status=${r.status}  bodyLen=${(r.respBody || "").length}`);
  if (r.reqBody) {
    console.log(`    req body (first 400 chars): ${r.reqBody.slice(0, 400).replace(/\s+/g, " ")}`);
  }
  if (r.respBody) {
    // Look for cues: lock, store, 1458, etc.
    const cues = ["lock", "Lock", "store", "Store", "1458", "0008", "UNLOCK", "Zone"];
    const found = cues.filter((c) => r.respBody.includes(c));
    if (found.length) console.log(`    resp matches cues: ${found.join(", ")}`);
    console.log(`    resp body (first 400 chars): ${r.respBody.slice(0, 400).replace(/\s+/g, " ")}`);
  }
}

writeFileSync("digitallocks-network.json", JSON.stringify(captured.filter((r) => r.method === "POST"), null, 2));
console.log("\nFull POST capture: digitallocks-network.json");

browser.disconnect();
process.exit(0);
