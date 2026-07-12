// dev/probe-digitallocks-replay-node.mjs
// Replay from Node directly (not from inside the Power BI page) using
// captured headers + cookies extracted from the browser.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const TARGET_STORE = (process.argv[2] || "658").trim();
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

const captured = JSON.parse(readFileSync("digitallocks-network.json", "utf8"));
const qes = captured.filter((d) => /QES\/QueryExecutionService/.test(d.url));
const dataQ = qes.find((q) => (q.reqBody || "").includes('"Property":"Lock Name"'));

// Get cookies for the target domain
const pages = await browser.pages();
const pbiPage = pages.find((p) => /app\.powerbi\.com/.test(p.url()));
const allCookies = await pbiPage.cookies(dataQ.url);
console.log(`✓ extracted ${allCookies.length} cookies for ${dataQ.url}`);
const cookieHeader = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");

// Build modified body
const body = JSON.parse(dataQ.reqBody);
body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Where[0].Condition.In.Values[0][0].Literal.Value = `'${TARGET_STORE}'`;

// Construct headers — pass auth + cookies + content-type, plus a fresh activity ID
const headers = {
  "Authorization": dataQ.reqHeaders["Authorization"],
  "Content-Type": "application/json;charset=UTF-8",
  "X-PowerBI-HostEnv": dataQ.reqHeaders["X-PowerBI-HostEnv"] || "Power BI Web App",
  "User-Agent": dataQ.reqHeaders["User-Agent"],
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://app.powerbi.com",
  "Referer": "https://app.powerbi.com/",
  "Cookie": cookieHeader,
};
// Bring along any other custom x-* headers from the original
for (const [k, v] of Object.entries(dataQ.reqHeaders)) {
  if (/^(x-|requestid|activityid)/i.test(k) && !headers[k]) headers[k] = v;
}

console.log(`→ POSTing to ${dataQ.url}`);
console.log(`  store filter: '${TARGET_STORE}'`);
console.log(`  ${Object.keys(headers).length} headers, ${cookieHeader.length}-char cookie header`);

const r = await fetch(dataQ.url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
const text = await r.text();

console.log(`\n========== RESPONSE ==========`);
console.log(`status: ${r.status}`);
console.log(`content-type: ${r.headers.get("content-type")}`);
console.log(`body length: ${text.length}`);
console.log(`\n--- body head (2KB) ---`);
console.log(text.slice(0, 2000));

if (text.includes(TARGET_STORE)) {
  console.log(`\n✓ Body contains "${TARGET_STORE}" — filter substitution WORKED.`);
}

browser.disconnect();
process.exit(0);
