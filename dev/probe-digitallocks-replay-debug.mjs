// dev/probe-digitallocks-replay-debug.mjs
// Progressive replay test to isolate why fetch fails.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const TARGET_STORE = (process.argv[2] || "658").trim();
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const target = pages.find((p) => /app\.powerbi\.com\/groups\/me\/reports\/a118e7e7-/.test(p.url()));
if (!target) { console.error("✗ no PBI tab"); browser.disconnect(); process.exit(1); }

const captured = JSON.parse(readFileSync("digitallocks-network.json", "utf8"));
const qes = captured.filter((d) => /QES\/QueryExecutionService/.test(d.url));
const dataQ = qes.find((q) => (q.reqBody || "").includes('"Property":"Lock Name"'));

const body = JSON.parse(dataQ.reqBody);
body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Where[0].Condition.In.Values[0][0].Literal.Value = `'${TARGET_STORE}'`;
const newBodyStr = JSON.stringify(body);

const r = await target.evaluate(async ({ url, allHeaders, body }) => {
  const probes = [];

  // T1: HEAD with no headers
  try {
    const r1 = await fetch(url, { method: "HEAD", mode: "cors", credentials: "include" });
    probes.push({ test: "T1 HEAD no-headers", status: r1.status, ok: r1.ok });
  } catch (e) { probes.push({ test: "T1 HEAD no-headers", err: e.message }); }

  // T2: POST with just Content-Type
  try {
    const r2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body, credentials: "include", mode: "cors",
    });
    probes.push({ test: "T2 POST content-type-only", status: r2.status, body: (await r2.text()).slice(0, 300) });
  } catch (e) { probes.push({ test: "T2 POST content-type-only", err: e.message }); }

  // T3: POST with content-type + Authorization
  try {
    const r3 = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Authorization": allHeaders["Authorization"],
      },
      body, credentials: "include", mode: "cors",
    });
    probes.push({ test: "T3 POST +auth", status: r3.status, body: (await r3.text()).slice(0, 300) });
  } catch (e) { probes.push({ test: "T3 POST +auth", err: e.message }); }

  // T4: POST with all original headers minus browser-managed
  try {
    const forbidden = new Set(["host","connection","content-length","accept-encoding",":method",":path",":scheme",":authority","cookie"]);
    const fwd = {};
    for (const [k, v] of Object.entries(allHeaders)) {
      if (!forbidden.has(k.toLowerCase())) fwd[k] = v;
    }
    const r4 = await fetch(url, { method: "POST", headers: fwd, body, credentials: "include", mode: "cors" });
    probes.push({ test: "T4 POST all-orig-headers", status: r4.status, body: (await r4.text()).slice(0, 300) });
  } catch (e) { probes.push({ test: "T4 POST all-orig-headers", err: e.message }); }

  return probes;
}, { url: dataQ.url, allHeaders: dataQ.reqHeaders, body: newBodyStr });

for (const p of r) {
  console.log("\n--- " + p.test + " ---");
  console.log(JSON.stringify(p, null, 2));
}

browser.disconnect();
process.exit(0);
