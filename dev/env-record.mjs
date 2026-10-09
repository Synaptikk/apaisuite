// dev/env-record.mjs <outFile> — record every write an Enviance form makes in the debug Edge.
// Attaches to each go.enviance.com page (incl. ones opened later) and appends one JSON line per
// non-GET request (and api.enviance.com calls) with its body, status and response. Run in background.
import { appendFileSync } from "node:fs";
const out = process.argv[2];
const attached = new Set();
const log = (o) => { appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); console.log(o.kind, o.status ?? "", o.method ?? "", (o.url || "").replace(/^https:\/\/[^/]+/, "").slice(0, 110)); };
async function attach(t) {
  attached.add(t.id);
  const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map(); const reqs = new Map();
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onclose = () => attached.delete(t.id);
  ws.onmessage = async (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    const p = d.params;
    if (d.method === "Network.requestWillBeSent") {
      const r = p.request;
      const interesting = r.method !== "GET" || /api\.enviance\.com/.test(r.url);
      if (!interesting || /\/apm\/|rum\/events|pendo/.test(r.url)) return;
      reqs.set(p.requestId, { url: r.url, method: r.method, body: r.postData || null, headers: Object.keys(r.headers || {}) });
    }
    if (d.method === "Network.responseReceived" && reqs.has(p.requestId)) reqs.get(p.requestId).status = p.response.status;
    if (d.method === "Network.loadingFinished" && reqs.has(p.requestId)) {
      const q = reqs.get(p.requestId); reqs.delete(p.requestId);
      const b = await send("Network.getResponseBody", { requestId: p.requestId });
      log({ kind: "req", page: t.url.slice(0, 120), ...q, resp: (b.result?.body || "").slice(0, 3000) });
    }
    if (d.method === "Network.loadingFailed" && reqs.has(p.requestId)) { const q = reqs.get(p.requestId); reqs.delete(p.requestId); log({ kind: "failed", ...q, error: p.errorText }); }
    if (d.method === "Page.javascriptDialogOpening") log({ kind: "dialog", url: t.url, message: p.message });
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Network.enable", { maxPostDataSize: 2_000_000 });
  if (t.type === "page") await send("Page.enable");
  log({ kind: "attached", url: t.url });
}
for (;;) {
  try {
    const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    // The WAB forms send their saves/closes from a service worker (sw.wab.js),
    // not the page, so attach to those too.
    for (const t of list) if (((t.type === "page" && /go\.enviance\.com\/(goto|CustomApp\/.*index)/.test(t.url)) || (t.type === "service_worker" && /go\.enviance\.com\/.*sw\.wab\.js/.test(t.url))) && !attached.has(t.id)) attach(t).catch((e) => log({ kind: "attach-error", url: t.url, error: String(e) }));
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
}
