import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const APP = `chrome-extension://${EXT}/app.html`;
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 200000 });

// Always a fresh shell handle — reusing a stale one is what hung the last run.
const shell = await browser.newPage();
await shell.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

const sess = () => shell.evaluate(() => chrome.storage.session.get(["cx.puppyAuth.result", "cx.puppyAuth.log"]));
const arm  = () => shell.evaluate(() => chrome.storage.session.set({ "cx.puppyAuth.armed": { at: Date.now(), nonce: "trace" } })
  .then(() => chrome.storage.session.remove(["cx.puppyAuth.result", "cx.puppyAuth.log"])));
const clear = () => shell.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.armed", "cx.puppyAuth.result", "cx.puppyAuth.log"]));

console.log("handler reachable:", JSON.stringify(await shell.evaluate(() => new Promise(r =>
  chrome.runtime.sendMessage({ module: "cx", type: "authDiagnostics" }, x => r(x?.ok ?? null))))));

const page = await browser.newPage();
await page.goto("https://puppy.walmart.com/authenticate_puppy", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 4000));
console.log("hook installed:", await page.evaluate(() => !String(window.fetch).includes("[native code]")));

// A) the relay path alone
await arm();
await page.evaluate(() => window.postMessage({ __apaisuite: "apaisuite-cx-puppy-token", token: "DIRECT-0123456789" }, location.origin));
await new Promise(r => setTimeout(r, 2500));
let s = await sess();
console.log("A direct postMessage -> len:", s["cx.puppyAuth.result"]?.token?.length ?? null, "log:", JSON.stringify(s["cx.puppyAuth.log"] ?? []));

// B) the full hook path
await arm();
await page.evaluate(async () => { try { await fetch("http://localhost:8090/save_token", { method: "POST", body: new URLSearchParams({ puppy_token: "VIA-HOOK-0123456789" }) }); } catch {} });
await new Promise(r => setTimeout(r, 2500));
s = await sess();
console.log("B hooked fetch       -> len:", s["cx.puppyAuth.result"]?.token?.length ?? null, "log:", JSON.stringify(s["cx.puppyAuth.log"] ?? []));

await clear();
await page.close(); await shell.close();
await browser.disconnect();
