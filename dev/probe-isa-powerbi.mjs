// dev/probe-isa-powerbi.mjs
//
// Purpose: discover the REAL Power BI DAX descriptor names behind the ISA
// Detail report's KPI cards — specifically the "Total Adjusted $" measure that
// modules/market120/lib/sources/isa_powerbi.js currently can't match.
//
// Strategy: attach to the already-running, already-authenticated Edge
// (remote-debugging port 9222), open (or reuse) the ISA Detail report tab,
// capture every QueryExecutionService POST, then decode each DSR response's
// descriptor.Select[*].Name → numeric value pairs. Prints the full list so we
// can pick the correct alias to add to the source's pickFirstNumeric() list.
//
// Read-only: never modifies requests. Never logs Authorization values.
//
// Output: dev/isa-powerbi-probe.json + a console summary.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

// ISA Detail report (from modules/market120/lib/sources/isa_powerbi.js).
const APP_ID    = "a185f4ed-8506-49a6-b135-743608a56ae6";
const CTID      = "3cbcc3d3-094d-4006-9849-0d11d61f484d";
const REPORT_ID = "b4835e03-3718-4b95-919f-8934bc83542c";
const REPORT_URL =
  `https://app.powerbi.com/groups/me/apps/${APP_ID}/reports/${REPORT_ID}` +
  `/ReportSection86afef1c8628ab2fa9d0?ctid=${CTID}&experience=power-bi`;

console.log("→ connecting to Edge on :9222 …");
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// Reuse an existing ISA Detail tab if the user already has one open.
const existing = browser.targets().filter(
  (t) => t.type() === "page" && new RegExp(REPORT_ID).test(t.url())
);
let page;
let opened = false;
if (existing.length) {
  console.log(`✓ found existing ISA Detail tab: ${existing[0].url().slice(0, 90)}…`);
  page = await existing[0].page();
} else {
  console.log("→ no existing tab; opening ISA Detail report…");
  page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  opened = true;
}

// Capture QES traffic via CDP.
const captured = [];
const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", (e) => {
  const url = e.request.url;
  if (!/QueryExecutionService|pbidedicated|analysis\.windows\.net/i.test(url)) return;
  captured.push({
    requestId: e.requestId,
    url,
    method: e.request.method,
    reqBody: e.request.postData ?? null,
    status: null,
    respBody: null,
  });
});
cdp.on("Network.responseReceived", (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (r) r.status = e.response.status;
});
cdp.on("Network.loadingFinished", async (e) => {
  const r = captured.find((x) => x.requestId === e.requestId);
  if (!r) return;
  try {
    const body = await cdp.send("Network.getResponseBody", { requestId: e.requestId });
    r.respBody = body.base64Encoded
      ? Buffer.from(body.body, "base64").toString("utf8")
      : (body.body || "");
  } catch {}
});

if (opened) {
  console.log(`→ navigating to ISA Detail report…`);
  try { await page.goto(REPORT_URL, { waitUntil: "networkidle2", timeout: 60000 }); }
  catch (e) { console.log(`  navigate finished with: ${e.message}`); }
} else {
  console.log(`  current URL: ${page.url()}`);
  try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); }
  catch (e) { console.log(`  reload finished with: ${e.message}`); }
}

console.log("→ waiting 20s for the report to fire its KPI-card queries…");
await new Promise((r) => setTimeout(r, 20_000));

try {
  await page.screenshot({ path: "isa-powerbi-screenshot.png", fullPage: false });
  console.log("  📸 isa-powerbi-screenshot.png");
} catch {}

// ── Decode every DSR response into { descriptorName: value } ──────────
// Mirrors modules/market120/lib/parse_dax.js so results match the extension.
function decodeAll(respBody) {
  const seen = {};
  if (!respBody || typeof respBody !== "string") return seen;
  let resp;
  try { resp = JSON.parse(respBody); } catch { return seen; }
  const results = resp?.results;
  if (!Array.isArray(results)) return seen;
  for (const result of results) {
    const data = result?.result?.data;
    if (!data) continue;
    const select = data.descriptor?.Select || [];
    const codeToName = {};
    for (const s of select) if (s?.Value) codeToName[s.Value] = s.Name || s.Value;
    for (const ds of (data.dsr?.DS || [])) {
      for (const phEntry of (ds.PH || [])) {
        for (const dmKey of Object.keys(phEntry).filter((k) => /^DM\d+$/.test(k))) {
          for (const row of (phEntry[dmKey] || [])) {
            for (const [k, v] of Object.entries(row)) {
              if (!/^[MG]\d+$/.test(k)) continue;
              const name = codeToName[k];
              if (!name) continue;
              const val = typeof v === "string" ? Number(v) : v;
              if (Number.isFinite(val) && !(name in seen)) seen[name] = val;
            }
            const schema = row?.S, c = row?.C;
            if (Array.isArray(schema) && Array.isArray(c)) {
              for (let i = 0; i < Math.min(schema.length, c.length); i++) {
                const name = codeToName[schema[i]?.N];
                if (!name) continue;
                const raw = c[i];
                const val = typeof raw === "string" ? Number(raw) : raw;
                if (Number.isFinite(val) && !(name in seen)) seen[name] = val;
              }
            }
          }
        }
      }
    }
  }
  return seen;
}

const queries = captured.filter((r) => /\/query\b|QueryExecutionService/i.test(r.url));
console.log(`\n=== ${captured.length} QES requests captured (${queries.length} look like queries) ===\n`);

const allDescriptors = {};
for (const r of queries) {
  const seen = decodeAll(r.respBody);
  for (const [name, val] of Object.entries(seen)) {
    if (!(name in allDescriptors)) allDescriptors[name] = val;
  }
}

console.log("=== ALL DESCRIPTOR NAMES SEEN (name → sample value) ===");
const entries = Object.entries(allDescriptors);
if (!entries.length) {
  console.log("  (none decoded — the KPI query may not have fired; try scrolling the report or check the screenshot)");
} else {
  for (const [name, val] of entries) {
    // Flag likely dollar measures (large magnitude or $/amt/retail in name).
    const flag = /amt|amount|retail|\$|adj.*(amt|retail)|dollar/i.test(name) ? "  💲 <-- likely Total Adjusted $"
      : (typeof val === "number" && Math.abs(val) > 100000) ? "  💰 (large value)" : "";
    console.log(`  ${JSON.stringify(name)}: ${val}${flag}`);
  }
}

writeFileSync("isa-powerbi-probe.json", JSON.stringify({ allDescriptors, captured }, null, 2));
console.log(`\n✓ Full capture → dev/isa-powerbi-probe.json`);

browser.disconnect();
process.exit(0);
