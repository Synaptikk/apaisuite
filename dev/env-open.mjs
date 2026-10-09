// dev/env-open.mjs <outDir> <seconds> <url|targetSubstring> [jsFile]
// url (http…): opens a NEW tab there and records it; otherwise attaches to an existing tab whose URL contains it.
// Records XHR/fetch/document bodies (incl. redirects into child frames via auto-attach is NOT handled), dumps innerText.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
const [out, secs = "20", where, js] = process.argv.slice(2); mkdirSync(out, { recursive: true });
let t;
if (/^https?:/.test(where)) {
  t = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
} else {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  t = list.find((x) => x.type === "page" && x.url.includes(where));
}
if (!t) { console.log("no target"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const reqs = new Map(); const log = []; let n = 0;
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = async (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === "Network.requestWillBeSent") { const r = d.params.request; reqs.set(d.params.requestId, { url: r.url, method: r.method, post: r.postData || "", type: d.params.type }); }
  if (d.method === "Network.responseReceived") { const q = reqs.get(d.params.requestId); if (q) q.status = d.params.response.status; }
  if (d.method === "Network.loadingFinished") {
    const q = reqs.get(d.params.requestId); if (!q || !["XHR", "Fetch", "Document"].includes(q.type)) return;
    const i = n++; const b = await send("Network.getResponseBody", { requestId: d.params.requestId });
    let body = b.result?.body || ""; if (b.result?.base64Encoded) body = Buffer.from(body, "base64").toString();
    const name = decodeURIComponent((q.url.match(/name=([^&]+)/) || [, q.url.slice(0, 160)])[1]);
    log.push({ i, status: q.status, method: q.method, name, len: body.length });
    writeFileSync(`${out}/r${String(i).padStart(3, "0")}.txt`, q.method + " " + q.url + "\n" + q.post + "\n----\n" + body);
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Page.setWebLifecycleState", { state: "active" });
await send("Network.enable", { maxPostDataSize: 500000 });
if (/^https?:/.test(where)) await send("Page.navigate", { url: where });
if (js) { await new Promise((r) => setTimeout(r, 1000)); const r = await send("Runtime.evaluate", { expression: readFileSync(js, "utf8"), returnByValue: true, awaitPromise: true }); console.log("js:", JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description)?.slice(0, 3000)); }
await new Promise((r) => setTimeout(r, +secs * 1000));
const txt = await send("Runtime.evaluate", { expression: "location.href + '\n' + document.body.innerText", returnByValue: true });
writeFileSync(`${out}/page.txt`, txt.result?.result?.value || "");
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
for (const l of log) console.log(l.i, l.status, l.method, l.len, l.name.replace("https://go.enviance.com", "").slice(0, 150));
console.log("target", t.id);
ws.close(); process.exit(0);
