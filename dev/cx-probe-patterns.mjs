// Which webRequest match-pattern form registers, and which actually matches a
// POST to localhost:8090? Chrome match patterns are documented as not carrying
// port numbers, so a literal ":53682" may be rejected outright — which would
// mean the listener never existed.
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
if (!sw) { console.log("SW not running"); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise(r => { ws.onopen = r; });
await call("Runtime.enable");

const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = (await browser.pages()).find(p => p.url().includes("app.html"));

const FORMS = [
  ["literal port",   ["http://127.0.0.1:53682/*", "http://localhost:53682/*"]],
  ["star port",      ["http://127.0.0.1:*/*", "http://localhost:*/*"]],
  ["no port",        ["http://127.0.0.1/*", "http://localhost/*"]],
];

for (const [name, urls] of FORMS) {
  const armed = await call("Runtime.evaluate", { expression: `(() => {
    globalThis.__t = [];
    if (globalThis.__tl) { try { chrome.webRequest.onBeforeRequest.removeListener(globalThis.__tl); } catch {} }
    globalThis.__tl = (d) => { globalThis.__t.push(d.url); };
    try {
      chrome.webRequest.onBeforeRequest.addListener(globalThis.__tl, { urls: ${JSON.stringify(urls)} }, ["requestBody"]);
      return { registered: true };
    } catch (e) { return { registered: false, err: String(e && e.message) }; }
  })()`, returnByValue: true });

  let matched = null;
  if (armed.result.value.registered) {
    // Exactly what the auth page does: POST to localhost:8090/save_token.
    await page.evaluate(async () => {
      try { await fetch("http://localhost:8090/save_token", { method: "POST", body: new URLSearchParams({ puppy_token: "PATTERN-TEST" }) }); } catch {}
    });
    await new Promise(r => setTimeout(r, 900));
    const seen = await call("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__t ?? [])", returnByValue: true });
    matched = JSON.parse(seen.result.value);
  }
  console.log(`${name.padEnd(14)} registered=${armed.result.value.registered}${armed.result.value.err ? " (" + armed.result.value.err + ")" : ""}  matched8090=${matched ? matched.length > 0 : "n/a"}`);
}

await call("Runtime.evaluate", { expression: `(() => { try { chrome.webRequest.onBeforeRequest.removeListener(globalThis.__tl); } catch {} delete globalThis.__tl; delete globalThis.__t; return 1; })()`, returnByValue: true });
ws.close(); await browser.disconnect();
