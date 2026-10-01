// Can the extension's service worker read the puppy_token out of the form POST
// the auth site makes to its localhost callback?
//
// Nothing needs to be LISTENING on that port: webRequest.onBeforeRequest fires
// when the browser forms the request, before the connection is attempted. If
// that holds, the extension can run the whole auth flow itself and capture the
// token with no native host and no paste.
//
// Uses a fake token value against a dead port — no real credential involved.
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
if (!sw) { console.log("SW not running — open the shell first"); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const call = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise(r => { ws.onopen = r; });
await call("Runtime.enable");

// 1. Arm a listener in the SW that stashes what it sees.
const armed = await call("Runtime.evaluate", { expression: `(() => {
  globalThis.__capture = [];
  if (globalThis.__capListener) chrome.webRequest.onBeforeRequest.removeListener(globalThis.__capListener);
  globalThis.__capListener = (details) => {
    globalThis.__capture.push({
      url: details.url, method: details.method, type: details.type,
      formKeys: details.requestBody?.formData ? Object.keys(details.requestBody.formData) : null,
      // Length only — never the value itself.
      tokenLen: details.requestBody?.formData?.puppy_token?.[0]?.length ?? null,
      raw: details.requestBody?.raw ? details.requestBody.raw.length : null,
    });
  };
  try {
    chrome.webRequest.onBeforeRequest.addListener(
      globalThis.__capListener,
      { urls: ["http://127.0.0.1/*", "http://localhost/*", "http://127.0.0.1:*/*", "http://localhost:*/*"] },
      ["requestBody"],
    );
    return { armed: true };
  } catch (e) { return { armed: false, err: String(e && e.message) }; }
})()`, returnByValue: true });
console.log("listener:", JSON.stringify(armed.result.value));

// 2. Make the browser attempt exactly the POST the auth site makes.
const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || (await browser.pages())[0];
const posted = await page.evaluate(async () => {
  const body = new URLSearchParams({ puppy_token: "FAKE-TOKEN-FOR-CAPTURE-TEST-0123456789" });
  try {
    await fetch("http://127.0.0.1:59999/save_token", { method: "POST", body });
    return "request completed";
  } catch (e) { return "request failed as expected: " + String(e.message).slice(0, 60); }
});
console.log("page:", posted);
await new Promise(r => setTimeout(r, 1500));

// 3. What did the SW see?
const seen = await call("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__capture ?? [])", returnByValue: true });
console.log("captured:", seen.result.value);

// 4. Clean up the probe listener.
await call("Runtime.evaluate", { expression: `(() => { if (globalThis.__capListener) chrome.webRequest.onBeforeRequest.removeListener(globalThis.__capListener); delete globalThis.__capListener; delete globalThis.__capture; return "cleaned"; })()`, returnByValue: true });
ws.close();
await browser.disconnect();
