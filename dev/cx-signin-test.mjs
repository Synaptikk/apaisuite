// The sign-in plumbing, without minting a real token.
//
// Two properties matter: an ARMED flow captures the posted token, and an
// UNARMED one ignores it — the second is the safety property, since the same
// POST happens whenever the user runs Code Puppy's own auth in their terminal.
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const FAKE = "FAKE.TOKEN.NOT-A-REAL-CREDENTIAL-0123456789";
const CALLBACK = "http://127.0.0.1:53682/save_token";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 120000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));

const post = () => page.evaluate(async (url, tok) => {
  try { await fetch(url, { method: "POST", body: new URLSearchParams({ puppy_token: tok }) }); }
  catch { /* dead port, expected */ }
}, CALLBACK, FAKE);

const session = () => page.evaluate(() => chrome.storage.session.get(["cx.puppyAuth.armed", "cx.puppyAuth.result"]));

// ── 1. UNARMED: the token must be ignored ───────────────────────────────
await page.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.armed", "cx.puppyAuth.result"]));
await post();
await new Promise(r => setTimeout(r, 1500));
const unarmed = await session();
console.log("UNARMED  result present:", !!unarmed["cx.puppyAuth.result"],
            unarmed["cx.puppyAuth.result"] ? "  <-- LEAK" : "  (correctly ignored)");

// ── 2. ARMED: the token must be captured ────────────────────────────────
await page.evaluate(() => chrome.storage.session.set({ "cx.puppyAuth.armed": { at: Date.now(), nonce: "test-nonce" } }));
await post();
await new Promise(r => setTimeout(r, 1500));
const armed = await session();
const res = armed["cx.puppyAuth.result"];
console.log("ARMED    captured:", !!res, res ? `len=${res.token.length} nonce=${res.nonce} matches=${res.token === FAKE}` : "");
console.log("ARMED    flag cleared after capture:", !armed["cx.puppyAuth.armed"]);

// ── 3. STALE arming must not capture ────────────────────────────────────
await page.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.armed", "cx.puppyAuth.result"]));
await page.evaluate(() => chrome.storage.session.set({ "cx.puppyAuth.armed": { at: Date.now() - 10 * 60_000, nonce: "old" } }));
await post();
await new Promise(r => setTimeout(r, 1500));
const stale = await session();
console.log("STALE    result present:", !!stale["cx.puppyAuth.result"],
            stale["cx.puppyAuth.result"] ? "  <-- LEAK" : "  (correctly ignored)");

// ── 4. The settings UI reflects the token state ─────────────────────────
await page.evaluate(() => chrome.storage.session.remove(["cx.puppyAuth.armed", "cx.puppyAuth.result"]));
await page.click("[data-action='open-settings']");
await new Promise(r => setTimeout(r, 600));
console.log("\nsettings UI:", JSON.stringify(await page.evaluate(() => ({
  signInLabel: document.querySelector("[data-action='signin-gateway']")?.textContent?.trim(),
  signOutHidden: document.querySelector("[data-action='signout-gateway']")?.hidden,
  status: document.querySelector("[data-token-status]")?.textContent?.trim(),
  pasteFallbackPresent: !!document.querySelector("[data-setting-token]"),
}))));
await browser.disconnect();
