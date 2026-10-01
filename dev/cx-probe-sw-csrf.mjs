// Which URL serves the csrfToken to a plain service-worker fetch?
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

const expr = `(async () => {
  const urls = [
    "https://walmart.medallia.com/sso/walmart/",
    "https://walmart.medallia.com/sso/walmart/pages/?roleId=251254",
    "https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5/pages/4899?roleId=251254",
    "https://walmart.medallia.com/sso/walmart/applications/ex_WEB-5",
    "https://walmart.medallia.com/dashboard.do",
  ];
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { credentials: "include", redirect: "follow" });
      const html = await r.text();
      const csrf = /csrfToken:\s*"([^"]+)"/.exec(html);
      const role = /roleId["'=:\s]+(\d{4,8})/.exec(r.url) || /roleId["'=:\s]+(\d{4,8})/.exec(html);
      out.push({ url: u.replace("https://walmart.medallia.com", "").slice(0, 70),
                 status: r.status, bytes: html.length,
                 finalPath: r.url.replace("https://walmart.medallia.com", "").slice(0, 70),
                 csrf: !!csrf, role: role ? role[1] : null,
                 // What other token-looking things are in there?
                 hints: [...new Set((html.match(/[A-Za-z]*[Tt]oken/g) || []))].slice(0, 6) });
    } catch (e) { out.push({ url: u, err: String(e && e.message) }); }
  }
  return out;
})()`;
const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
if (r.exceptionDetails) { console.log("THREW:", r.exceptionDetails.text); }
else for (const o of r.result.value) console.log(JSON.stringify(o));
ws.close();
