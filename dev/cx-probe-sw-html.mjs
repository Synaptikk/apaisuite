const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise(r => { ws.onopen = r; });
await call("Runtime.enable");
const r = await call("Runtime.evaluate", {
  expression: `(async () => {
    const res = await fetch("https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254", { credentials: "include" });
    const html = await res.text();
    const i = html.indexOf("csrfToken");
    return { finalUrl: res.url, bytes: html.length, around: i === -1 ? null : html.slice(Math.max(0, i - 400), i + 500) };
  })()`,
  awaitPromise: true, returnByValue: true, timeout: 60000,
});
const v = r.result.value;
console.log("finalUrl:", v.finalUrl, "\nbytes:", v.bytes, "\n--- around csrfToken ---\n" + (v.around ?? "(absent)"));
ws.close();
