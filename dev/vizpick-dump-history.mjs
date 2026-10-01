// dev/vizpick-dump-history.mjs — dump the home-store pick history out of the
// dev-mirror extension over the debug Edge (port 9222) to a JSON file, in
// chunks (the whole history is megabytes; one returnByValue never settles).
//   node dev/vizpick-dump-history.mjs <outfile>
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const OUT = process.argv[2];
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

const keys = await evaluate(`chrome.storage.local.get(null).then((all) => Object.keys(all).map((k) => k + " :: " + JSON.stringify(all[k] ?? null).length).sort())`);
console.log("storage keys:\n" + (keys || []).join("\n"));

await evaluate(`chrome.storage.local.get(["vizpick.homeHistory.v1","vizpick.homeHistory.polls.v1","shared.associateDirectory.v1"]).then((g) => { window.__dump = JSON.stringify(g); return window.__dump.length; })`);
const len = await evaluate(`window.__dump.length`);
console.log("payload bytes:", len);
let out = "";
for (let i = 0; i < len; i += CHUNK) out += await evaluate(`window.__dump.slice(${i}, ${i + CHUNK})`);
await evaluate(`delete window.__dump`);
await fs.writeFile(OUT, out);
const parsed = JSON.parse(out);
console.log("days:", Object.keys(parsed["vizpick.homeHistory.v1"]?.days || {}).join(","));
ws.close();
