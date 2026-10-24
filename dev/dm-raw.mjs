// Raw-CDP dm call against the open app.html tab (avoids puppeteer hangs on frozen tabs).
// Usage: node dm-raw.mjs '<js expression returning a promise>'  (module messages via call(type,payload))
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && x.url.includes("fchnolphfaklbpdgnofhblfhcailkpdb/app.html"));
if (!t) throw new Error("no app.html tab");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); });
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
export async function evalJs(expr) {
  const m = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 500));
  return m.result?.result?.value;
}
export async function call(type, payload = {}, module = "digitalmetrics") {
  const r = await evalJs(`chrome.runtime.sendMessage(${JSON.stringify({ module, type, ...payload })})`);
  if (!r?.ok) throw new Error(`${type}: ${r?.error || JSON.stringify(r)?.slice(0, 200)}`);
  return r.data;
}
export const close = () => ws.close();
if (process.argv[1].endsWith("dm-raw.mjs") && process.argv[2]) { console.log(JSON.stringify(await evalJs(process.argv[2])).slice(0, 4000)); close(); }
