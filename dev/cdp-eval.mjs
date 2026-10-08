// dev/cdp-eval.mjs <urlSubstring> <exprFile> [outFile] — evaluate an expression in
// ONE target over raw CDP (no puppeteer: its attach hangs on frozen tabs).
import { readFileSync, writeFileSync } from "node:fs";
const [match, exprFile, out] = process.argv.slice(2);
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && x.url.includes(match));
if (!t) { console.error("no target for", match); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
await send("Page.setWebLifecycleState", { state: "active" });
const r = await send("Runtime.evaluate", { expression: readFileSync(exprFile, "utf8"), returnByValue: true, awaitPromise: true, timeout: 120000 });
const v = r.result?.result?.value ?? r.result?.exceptionDetails ?? r.error;
if (out) writeFileSync(out, JSON.stringify(v, null, 1)); else console.log(JSON.stringify(v, null, 1));
ws.close();
