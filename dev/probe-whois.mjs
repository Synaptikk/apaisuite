// dev/probe-whois.mjs
//
// Capture XHRs fired by the actual people-search page
// (.../directory/directory-tools/who-is-search.html) when searching a username.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

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
      ? Buffer.from(b.body, "base64").toString("utf8").slice(0, 4096)
      : (b.body || "").slice(0, 4096);
  } catch {}
});

const URL = "https://one.walmart.com/content/uswire/en_us/directory/directory-tools/who-is-search.html";
console.log(`→ ${URL}`);
await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

await page.screenshot({ path: "whois-screenshot.png", fullPage: true });

// Inspect inputs on this page
const inputs = await page.evaluate(() => [...document.querySelectorAll("input, select, textarea")].map((el) => ({
  tag: el.tagName, type: el.type, id: el.id, name: el.name, ph: el.placeholder,
  aria: el.getAttribute("aria-label"), vis: el.offsetParent !== null,
})));
console.log("Inputs:");
inputs.filter((i) => i.vis).slice(0, 20).forEach((i) =>
  console.log(`  ${i.tag} type=${i.type} id=${i.id || "-"} name=${i.name || "-"} ph="${i.ph || ""}" aria="${i.aria || ""}"`));

const cutoff = captured.length;
console.log(`\n→ snapshot cutoff at ${cutoff} requests; now searching for "ses008s"…`);

// Pick the most search-looking text field
const sels = ['input[type="search"]', 'input[type="text"]:not([type="hidden"])', 'input[name*="user" i]', 'input[id*="search" i]'];
let sel = null;
for (const s of sels) {
  if (await page.$(s)) { sel = s; break; }
}
console.log(`  using selector: ${sel}`);
if (sel) {
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.type(sel, "ses008s", { delay: 70 });
  await page.keyboard.press("Enter").catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));
}

const xhrs = captured.slice(cutoff).filter((r) => r.type === "XHR" || r.type === "Fetch");
console.log(`\n========== ${xhrs.length} XHR/Fetch after search ==========`);
for (const r of xhrs) {
  console.log(`\n${r.method} ${r.url}`);
  console.log(`  status=${r.status}  mime=${r.mimeType}`);
  if (r.reqBody) console.log(`  REQ: ${String(r.reqBody).slice(0, 500)}`);
  if (r.respBody) console.log(`  RES: ${String(r.respBody).slice(0, 1500)}`);
}

writeFileSync("whois-probe.json", JSON.stringify(captured, null, 2));
console.log(`\n✓ Full → whois-probe.json   Screenshot → whois-screenshot.png`);
console.log(`✓ Final URL: ${page.url()}`);
browser.disconnect();
process.exit(0);
