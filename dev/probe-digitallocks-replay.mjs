// dev/probe-digitallocks-replay.mjs
// Replay the captured digitallocks data-grid DAX query with a modified
// store filter, to verify (a) MWCToken auth is replayable and (b) the
// store-filter substitution returns different data.

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
if (!dataQ) { console.error("✗ no captured data-grid query"); browser.disconnect(); process.exit(1); }

console.log(`✓ captured data-grid query for original store:`,
  dataQ.reqBody.match(/Literal":\{"Value":"'([^']+)'/)?.[1] || "?");
console.log(`→ replaying with store="${TARGET_STORE}"…`);

// Modify body: replace the store filter value.
const body = JSON.parse(dataQ.reqBody);
const where = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Query.Where;
where[0].Condition.In.Values[0][0].Literal.Value = `'${TARGET_STORE}'`;
// Also patch the CacheKey to match (Power BI uses it for caching)
const newBodyStr = JSON.stringify(body).replace(/"CacheKey":"[^"]*"/, () => {
  const cacheKey = JSON.stringify(body.queries[0].Query).replace(/"/g, '\\"');
  return `"CacheKey":"${cacheKey}"`;
});

// Replay the request from inside the Power BI page so cookies + CORS work.
const result = await target.evaluate(async ({ url, headers, body }) => {
  // Only strip headers that the browser MUST manage itself; pass everything else.
  const forbidden = new Set([
    "host", "connection", "content-length", "accept-encoding",
    ":method", ":path", ":scheme", ":authority", "cookie",
  ]);
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (forbidden.has(k.toLowerCase())) continue;
    forwardHeaders[k] = v;
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: forwardHeaders,
      body,
      credentials: "include",
      mode: "cors",
    });
    const text = await r.text();
    return {
      status: r.status,
      contentType: r.headers.get("content-type"),
      bodyLength: text.length,
      bodyHead: text.slice(0, 2000),
      forwardedHeaderNames: Object.keys(forwardHeaders),
    };
  } catch (e) {
    return { error: e?.message || String(e), stack: e?.stack };
  }
}, { url: dataQ.url, headers: dataQ.reqHeaders, body: newBodyStr });

console.log(`\n========== REPLAY RESULT ==========`);
console.log(`status:        ${result.status}`);
console.log(`content-type:  ${result.contentType}`);
console.log(`body length:   ${result.bodyLength}`);
console.log(`error:         ${result.error || "(none)"}`);
console.log(`\n--- body head (2KB) ---`);
console.log(result.bodyHead || "(empty)");

// Sanity: did the response mention our new store number, indicating filter worked?
if (result.bodyHead && result.bodyHead.includes(TARGET_STORE)) {
  console.log(`\n✓ Response contains "${TARGET_STORE}" — filter substitution APPEARS to work.`);
} else if (result.status === 200) {
  console.log(`\n⚠ 200 but body doesn't mention "${TARGET_STORE}" — verify by inspecting full response.`);
}

browser.disconnect();
process.exit(0);
