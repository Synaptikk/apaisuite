// dev/vizpick-dump-people.mjs — WIN → name from apai.assoc.*, plus the
// digitalmetrics schedule (job + shift) for each day given, over debug Edge.
//   node dev/vizpick-dump-people.mjs <outfile> <day> [day...]
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const OUT = process.argv[2];
const DAYS = process.argv.slice(3);
const CHUNK = 400_000;
const fs = await import("node:fs/promises");

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const app = targets.find((t) => t.type === "page" && t.url.startsWith(`chrome-extension://${EXT}/app.html`));
if (!app) throw new Error("no app.html tab open in the debug Edge");
const ws = new WebSocket(app.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const big = async (expr) => {
  await evaluate(`Promise.resolve(${expr}).then((v) => { window.__d = JSON.stringify(v ?? null); return 1; })`);
  const len = await evaluate(`window.__d.length`);
  let out = "";
  for (let i = 0; i < len; i += CHUNK) out += await evaluate(`window.__d.slice(${i}, ${i + CHUNK})`);
  await evaluate(`delete window.__d`);
  return JSON.parse(out);
};

const people = await big(`chrome.storage.local.get(null).then((all) => { const o = {}; for (const [k, v] of Object.entries(all)) if (k.startsWith("apai.assoc.") && !k.startsWith("apai.assoc.miss.")) o[k.slice(11)] = v; return o; })`);
console.log("people:", Object.keys(people).length);

const schedules = {};
for (const day of DAYS) {
  const r = await big(`new Promise((res) => chrome.runtime.sendMessage({ module: "digitalmetrics", type: "get_schedule", store: "1458", date: "${day}" }, (x) => res({ err: chrome.runtime.lastError?.message ?? null, doc: x })))`);
  schedules[day] = r;
  const doc = r?.doc?.schedule ?? r?.doc;
  console.log(day, "err:", r?.err, "rows:", Array.isArray(doc?.rows) ? doc.rows.length : Array.isArray(doc) ? doc.length : Object.keys(doc || {}).length);
}
await fs.writeFile(OUT, JSON.stringify({ people, schedules }, null, 1));
console.log("wrote", (await fs.stat(OUT)).size, "bytes");
ws.close();
