// Does the page hook fire on the REAL origin? This is the test the earlier ones
// should have been: everything runs on https://puppy.walmart.com, never on an
// extension page.
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 150000 });

// Arm a flow from the shell, exactly as the Sign in button does.
const shell = (await browser.pages()).find(p => p.url().includes("app.html"));
await shell.evaluate(() => chrome.storage.session.set({ "cx.puppyAuth.armed": { at: Date.now(), nonce: "hook-test" } }));
await shell.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.result", "cx.puppyAuth.log"]));
console.log("armed a flow");

const page = await browser.newPage();
await page.goto("https://puppy.walmart.com/authenticate_puppy", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 4000));
console.log("auth page:", page.url().slice(0, 80));

// Is the MAIN-world hook actually installed on this page?
console.log("fetch patched:", await page.evaluate(() => !String(window.fetch).includes("[native code]")));

// Drive the same call the page makes. The network will fail (PNA); the hook
// should still have seen the body.
const FAKE = "FAKE.HOOK.TEST.TOKEN-0123456789abcdef";
console.log("page fetch:", await page.evaluate(async (t) => {
  try { await fetch("http://localhost:8090/save_token", { method: "POST", body: new URLSearchParams({ puppy_token: t }) }); return "ok"; }
  catch (e) { return "threw (expected): " + String(e.message).slice(0, 40); }
}, FAKE));

await new Promise(r => setTimeout(r, 2000));
const state = await shell.evaluate(() => chrome.storage.session.get(["cx.puppyAuth.result", "cx.puppyAuth.log", "cx.puppyAuth.armed"]));
const res = state["cx.puppyAuth.result"];
console.log("\ncaptured:", !!res, res ? `len=${res.token.length} exact=${res.token === "FAKE.HOOK.TEST.TOKEN-0123456789abcdef"} nonce=${res.nonce}` : "");
console.log("log:", JSON.stringify(state["cx.puppyAuth.log"] ?? []));
console.log("armed cleared:", !state["cx.puppyAuth.armed"]);

// And the safety property, on the real origin.
await shell.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.armed", "cx.puppyAuth.result", "cx.puppyAuth.log"]));
await page.evaluate(async () => { try { await fetch("http://localhost:8090/save_token", { method: "POST", body: new URLSearchParams({ puppy_token: "UNARMED" }) }); } catch {} });
await new Promise(r => setTimeout(r, 1500));
const after = await shell.evaluate(() => chrome.storage.session.get("cx.puppyAuth.result"));
console.log("UNARMED captured:", !!after["cx.puppyAuth.result"], "(want false)");

await shell.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.armed", "cx.puppyAuth.result", "cx.puppyAuth.log"]));
await page.close();
await browser.disconnect();
