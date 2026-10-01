// Same four variants, but issued from the extension service worker — node did
// not reproduce the thinking blocks, so the difference is the caller.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const tok = /^puppy_token\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(os.homedir(), ".code_puppy", "puppy.cfg"), "utf8"))?.[1]?.trim();
const box = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { buildAnalysis } = await import("../modules/cx/lib/aggregate.js");
const narr = await import("../modules/cx/lib/narrative.js");
const analysis = buildAnalysis(box.records, { filters: {}, windowDays: 28 });
const facts = narr.promptFacts(analysis, { storeNbr: "1458", scores: null });
const user = "Store 1458. Write the Cx read-out from the figures below.\n\n```json\n" + JSON.stringify(facts, null, 1) + "\n```";

const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
if (!sw) { console.log("SW not running"); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise(r => { ws.onopen = r; });
await call("Runtime.enable");

const variants = [
  ["max_tokens 2000 (current)",           { max_tokens: 2000 }],
  ["max_tokens 2000 + thinking disabled", { max_tokens: 2000, thinking: { type: "disabled" } }],
  ["max_tokens 8000",                     { max_tokens: 8000 }],
  ["max_tokens 8000 + thinking disabled", { max_tokens: 8000, thinking: { type: "disabled" } }],
];

for (const [name, extra] of variants) {
  const body = { model: "claude-sonnet-5", system: "You write short Cx read-outs. Use the figures given; do not derive any.", messages: [{ role: "user", content: user }], ...extra };
  const expr = `(async () => {
    const t0 = Date.now();
    const r = await fetch("https://puppy-backend.walmart.com/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": ${JSON.stringify(tok)}, "anthropic-version": "2023-06-01" },
      body: ${JSON.stringify(JSON.stringify(body))},
    });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { return { status: r.status, raw: t.slice(0,200) }; }
    const txt = (j.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    return { status: r.status, ms: Date.now()-t0, stop: j.stop_reason,
             blocks: (j.content||[]).map(b=>b.type).join(","), text: txt.length,
             think: j.usage && j.usage.output_tokens_details && j.usage.output_tokens_details.thinking_tokens,
             out: j.usage && j.usage.output_tokens, err: j.error ? JSON.stringify(j.error).slice(0,200) : null };
  })()`;
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 });
  const v = r.exceptionDetails ? { threw: r.exceptionDetails.text } : r.result.value;
  console.log(name.padEnd(38), JSON.stringify(v));
}
ws.close();
