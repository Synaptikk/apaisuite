// dev/env-shot.mjs <targetSubstring> <out.png> — screenshot one tab over raw CDP.
import { writeFileSync } from "node:fs";
const [match, out] = process.argv.slice(2);
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && x.url.includes(match));
if (!t) { console.log("no target"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
await send("Page.setWebLifecycleState", { state: "active" });
const r = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(r.result.data, "base64")); console.log(t.url); ws.close(); process.exit(0);
