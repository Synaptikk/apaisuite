// dev/probe-digitallocks-dsr-full.mjs
// Fresh replay with full (untruncated) response capture, write to disk for
// structural analysis.

import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";

const TARGET_STORE = (process.argv[2] || "658").trim();
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

const captured = JSON.parse(readFileSync("digitallocks-network.json", "utf8"));
const qes = captured.filter((d) => /QES\/QueryExecutionService/.test(d.url));
const dataQ = qes.find((q) => (q.reqBody || "").includes('"Property":"Lock Name"'));

const body = JSON.parse(dataQ.reqBody);
body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Where[0].Condition.In.Values[0][0].Literal.Value = `'${TARGET_STORE}'`;

const headers = {
  "Authorization": dataQ.reqHeaders["Authorization"],
  "Content-Type": "application/json;charset=UTF-8",
  "X-PowerBI-HostEnv": "Power BI Web App",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://app.powerbi.com",
};

const r = await fetch(dataQ.url, { method: "POST", headers, body: JSON.stringify(body) });
const text = await r.text();
console.log(`status=${r.status} bytes=${text.length}`);

writeFileSync("digitallocks-dsr-full.json", text);
console.log("Saved: digitallocks-dsr-full.json");

// Parse + inspect structure
const parsed = JSON.parse(text);
const data = parsed.results?.[0]?.result?.data;
const dsr = data?.dsr;
console.log("\n== DSR keys ==", Object.keys(dsr || {}));
console.log("== DS[0] keys ==", Object.keys(dsr?.DS?.[0] || {}));
console.log("== DS[0] top-level non-PH keys ==");
for (const [k, v] of Object.entries(dsr?.DS?.[0] || {})) {
  if (k === "PH") continue;
  if (typeof v === "object") console.log(`  ${k}: ${JSON.stringify(v).slice(0, 800)}`);
  else console.log(`  ${k}: ${v}`);
}
console.log("== PH[0] top-level keys ==", Object.keys(dsr?.DS?.[0]?.PH?.[0] || {}));
console.log("== DM0 length ==", dsr?.DS?.[0]?.PH?.[0]?.DM0?.length);
console.log("== First 3 DM0 entries ==");
for (const r of (dsr?.DS?.[0]?.PH?.[0]?.DM0 || []).slice(0, 3)) console.log(`  ${JSON.stringify(r)}`);

// Print full descriptor
console.log("\n== Descriptor.Select (column metadata) ==");
for (const s of (data?.descriptor?.Select || [])) {
  console.log(`  ${s.Value}  Name=${s.Name}  Property=${s.GroupKeys?.[0]?.Source?.Property}`);
}

browser.disconnect();
process.exit(0);
