// Does an HTTPS page's fetch to localhost actually emit an observable POST?
//
// My earlier tests posted from app.html — a chrome-extension:// page, which is
// exempt from Private Network Access. The auth page is a public HTTPS origin,
// and PNA makes those preflight before touching a local address. If the
// preflight fails (nothing listening) the POST is never sent at all, and the
// listener has nothing to see.
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
if (!sw) { console.log("SW not running"); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (m, p={}) => new Promise((res, rej) => { const i=++id; pend.set(i,{res,rej}); ws.send(JSON.stringify({id:i,method:m,params:p})); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p=pend.get(m.id); pend.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result); } };
await new Promise(r => { ws.onopen = r; });
await call("Runtime.enable");

// Observe EVERY method, not just POST, so a preflight-only outcome is visible.
await call("Runtime.evaluate", { expression: `(() => {
  globalThis.__pna = [];
  if (globalThis.__pl) { try { chrome.webRequest.onBeforeRequest.removeListener(globalThis.__pl); } catch {} }
  globalThis.__pl = (d) => globalThis.__pna.push({ method: d.method, url: d.url, hasBody: !!d.requestBody,
    fields: d.requestBody?.formData ? Object.keys(d.requestBody.formData) : null });
  chrome.webRequest.onBeforeRequest.addListener(globalThis.__pl, { urls: ["http://127.0.0.1/*","http://localhost/*"] }, ["requestBody"]);
  return 1;
})()`, returnByValue: true });

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

for (const [label, url] of [
  ["extension page (chrome-extension://)", `chrome-extension://${EXT}/app.html`],
  ["public HTTPS page (the real case)",    "https://puppy.walmart.com/authenticate_puppy"],
]) {
  await call("Runtime.evaluate", { expression: "globalThis.__pna = []", returnByValue: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    const outcome = await page.evaluate(async () => {
      try { await fetch("http://localhost:8090/save_token", { method: "POST", body: new URLSearchParams({ puppy_token: "PNA-TEST-VALUE" }) }); return "ok"; }
      catch (e) { return "threw: " + String(e.message).slice(0, 60); }
    });
    await new Promise(r => setTimeout(r, 1500));
    const seen = JSON.parse((await call("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__pna)", returnByValue: true })).result.value);
    console.log(`\n${label}\n  page fetch: ${outcome}`);
    console.log(`  SW observed ${seen.length}:`);
    for (const o of seen) console.log(`    ${o.method.padEnd(8)} body=${o.hasBody} fields=${JSON.stringify(o.fields)}`);
  } catch (e) {
    console.log(`\n${label}\n  could not load: ${String(e.message).slice(0, 90)}`);
  }
  await page.close().catch(() => {});
}

await call("Runtime.evaluate", { expression: `(() => { try{chrome.webRequest.onBeforeRequest.removeListener(globalThis.__pl);}catch{} delete globalThis.__pl; delete globalThis.__pna; return 1; })()`, returnByValue: true });
ws.close(); await browser.disconnect();
