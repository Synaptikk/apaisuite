// dev/registerls-open-check.mjs — reload the debug-Edge extension, open Register L/S Triage and
// check (1) opening it never activates another tab, (2) the WorkView pull on open drops items
// dispositioned in APPRISS, (3) with the APPRISS cookies removed, refresh_queue still succeeds
// through the silent background reauth. Usage: node dev/registerls-open-check.mjs [workItemId]
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const GONE_ID = process.argv[2] || "14663686";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 240000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await new Promise((r) => setTimeout(r, 4000));
page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url().slice(0, 140)}`); });
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.bringToFront();
const me = await page.evaluate(() => new Promise((res) => chrome.tabs.getCurrent((t) => res({ id: t.id, windowId: t.windowId }))));
const activeNow = () => page.evaluate((w) => new Promise((res) => chrome.tabs.query({ active: true, windowId: w }, (ts) => res(ts.map((t) => ({ id: t.id, url: (t.url || "").slice(0, 80) }))))), me.windowId);
console.log("app tab", me, "active before:", await activeNow());
const tabsBefore = await page.evaluate(() => new Promise((res) => chrome.tabs.query({}, (ts) => res(ts.length))));
await page.goto(`chrome-extension://${EXT}/app.html#/registerls`, { waitUntil: "domcontentloaded" });
// bootstrap: WorkView (+ whatever else is stale) then analyze_all
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const p = await page.evaluate(() => document.querySelector("[data-progress]")?.textContent || "");
  const spin = await page.evaluate(() => [...document.querySelectorAll(".btn-spinner")].some((s) => !s.hidden));
  if (!p && !spin && i > 2) break;
}
const after = await activeNow();
const tabsAfter = await page.evaluate(() => new Promise((res) => chrome.tabs.query({}, (ts) => res(ts.length))));
const paint = await page.evaluate((gone) => ({
  queuePill: document.querySelector("[data-pill='queue']")?.textContent || "",
  stale: document.querySelector(".rls-stale")?.textContent || "",
  goneListed: !!document.querySelector(`.rls-row[data-id='${gone}'], [data-id='${gone}']`),
  rows: document.querySelectorAll(".rls-row").length,
  others: document.querySelectorAll("[data-other-id], .rls-other").length,
}), GONE_ID);
console.log("active after open:", after, "still the app tab:", after.length === 1 && after[0].id === me.id);
console.log("tab count before/after:", tabsBefore, tabsAfter);
console.log("paint:", paint);

// (3) expire APPRISS cookies, then refresh_queue must succeed via reauth
const removed = await page.evaluate(() => new Promise((res) => chrome.cookies.getAll({ domain: "apps.apprissretail.com" }, async (cs) => {
  for (const c of cs) await new Promise((r) => chrome.cookies.remove({ url: `https://${c.domain.replace(/^\./, "")}${c.path}`, name: c.name }, r));
  res(cs.length);
})));
console.log("removed APPRISS cookies:", removed);
const t0 = Date.now();
const res = await page.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ module: "registerls", type: "refresh_queue" }, (r) => res(r))));
console.log(`refresh_queue after cookie wipe (${Math.round((Date.now() - t0) / 1000)}s):`, JSON.stringify(res).slice(0, 300));
const after2 = await activeNow();
const tabsAfter2 = await page.evaluate(() => new Promise((res) => chrome.tabs.query({}, (ts) => res(ts.length))));
console.log("active after reauth:", after2, "tabs:", tabsAfter2);
if (errors.length) console.log("page errors:", errors.slice(0, 5));
await page.close();
browser.disconnect();
