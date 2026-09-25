// dev/probe-clearsight-claim.mjs
//
// Discovery probe for the Accident module (CURRENT_TASKS §5b expansion):
// what does the Clearsight PROD claim dashboard
// (#/dashboards/stars.claim/<id>) load, and which read-only GETs give us
// the claim description / customer description / evidence collection state?
//
// Read-only: GETs only, nothing is posted.
// Run: node dev/probe-clearsight-claim.mjs <targetId> [claimId]
//
// Raw CDP over WebSocket to ONE target (puppeteer's pages() hangs on the
// profile's frozen tabs — see memory: vizpick-tab-leak).

import fs from "node:fs";

const TARGET = process.argv[2];
const CLAIM_ID = process.argv[3] || "10208885";
const BASE = "https://www.riskonnectclearsight.com/Walmart";
const DASH = `${BASE}/app/Clearsight/#/dashboards/stars.claim/${CLAIM_ID}`;
const OUT = "dev/.claim-probe/";
fs.mkdirSync(OUT, { recursive: true });

const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${TARGET}`);
let seq = 0;
const pending = new Map();
const netLog = [];
const bodies = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Network.responseReceived") {
    const { type, response, requestId } = m.params;
    if ((type === "XHR" || type === "Fetch") && response.url.includes("riskonnectclearsight.com")) {
      netLog.push({ requestId, status: response.status, url: response.url, mime: response.mimeType });
    }
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timeout`)); } }, 60000);
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => { ws.onopen = r; });
await send("Network.enable");
await send("Page.enable");
await send("Page.navigate", { url: DASH });
console.log("Navigating to", DASH);
await sleep(15000);

const where = await evaluate("location.href");
console.log("Landed on:", where);
if (/login\.cmdx|pingfed|ssologin|SsoSession/i.test(where)) {
  console.log("NOT SIGNED IN — complete SSO in the opened tab, then re-run.");
  process.exit(2);
}
await sleep(10000); // let the dashboard finish its XHRs

// Pull bodies of the dashboard's own XHRs.
for (let i = 0; i < netLog.length; i++) {
  const e = netLog[i];
  try {
    const r = await send("Network.getResponseBody", { requestId: e.requestId });
    const body = r.result?.body || "";
    if (body && /json/i.test(e.mime)) {
      const f = `resp-${String(i).padStart(3, "0")}.json`;
      fs.writeFileSync(OUT + f, body);
      e.file = f; e.bytes = body.length;
    }
  } catch { /* evicted */ }
}

// Try predicted read endpoints (read-only GETs).
const candidates = [
  `RMIS/STARS.Claim.mvc/FormData?id=${CLAIM_ID}`,
  `RMIS/STARS.Claim.mvc/FormData?id=${CLAIM_ID}&groupKeys=1,20`,
  `RMIS/STARS.Claim.mvc/CsFolderMetaData?groupKeys=1,20`,
];
for (const path of candidates) {
  try {
    const r = await evaluate(`fetch(${JSON.stringify(`${BASE}/${path}`)}, {credentials:"include", headers:{Accept:"application/json"}}).then(async t => ({status:t.status, body: await t.text()}))`);
    console.log(`\nGET ${path} -> ${r.status} (${r.body.length} bytes): ${r.body.replace(/\s+/g, " ").slice(0, 200)}`);
    if (r.status === 200 && !/^\s*</.test(r.body)) fs.writeFileSync(OUT + "try-" + path.replace(/[^a-z0-9]+/gi, "_").slice(0, 80) + ".json", r.body);
  } catch (e) { console.log(`\nGET ${path} -> ERROR ${e.message}`); }
}

fs.writeFileSync(OUT + "network-log.json", JSON.stringify(netLog, null, 2));
console.log(`\n${netLog.length} dashboard XHRs:`);
for (const e of netLog) console.log(` ${e.status} ${e.url.replace(BASE, "")}${e.file ? "  [" + e.file + " " + e.bytes + "b]" : ""}`);
ws.close();
process.exit(0);
