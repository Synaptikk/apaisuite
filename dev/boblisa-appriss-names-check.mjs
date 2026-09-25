// dev/boblisa-appriss-names-check.mjs — reload the debug-Edge extension, open BoB and Lisa,
// click "Look up names in APPRISS" and report what boblisa.operators.<store> holds
// (needs an APPRISS session in the debug profile; SSO usually completes on its own
// when you open https://apps.apprissretail.com/walmart-usa/secure/sso/saml2 there).
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 900000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await sleep(4000);
page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
await page.goto(`chrome-extension://${EXT}/app.html#/boblisa`, { waitUntil: "domcontentloaded" });
await page.bringToFront();   // a background tab gets discarded by Edge during the long lookup and its frame detaches
const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error("no element " + s); el.click(); }, sel);
const reattach = async () => { const pages = await browser.pages(); const p = pages.find((x) => x.url().includes(`${EXT}/app.html`)); if (p) { page = p; await page.bringToFront(); } };
const text = async (sel) => { try { return await page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel); } catch (e) { if (!/detached/i.test(String(e))) throw e; await reattach(); return page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel); } };
const _text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
await sleep(4000);
const before = await page.evaluate(() => chrome.storage.local.get("boblisa.operators.1458").then((r) => { const d = r["boblisa.operators.1458"] || {}; return { names: Object.keys(d.names || {}).length, people: Object.keys(d.people || {}).length }; }));
await click('.bl-tab[data-tab="cashiers"]');
const t0 = Date.now();
await click("#boblisa-names");
let prog = "";
for (let i = 0; i < 150; i++) { await sleep(4000); prog = await text("#boblisa-progress"); if (i % 10 === 9) log({ prog }); if (!prog && i > 0) break; }
const status = await text("#boblisa-status");
const after = await page.evaluate(() => chrome.storage.local.get("boblisa.operators.1458").then((r) => { const d = r["boblisa.operators.1458"] || {}; const people = Object.values(d.people || {}); return { names: Object.keys(d.names || {}).length, people: people.length, sample: people.slice(0, 6).map((p) => `${p.op} ${p.name} WIN ${p.win} ${p.role}`), banners: Object.entries(d.names).filter(([op]) => !d.people[op]).slice(0, 4) }; }));
const drawers = await page.evaluate(() => chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith("boblisa.drawer.1458.")).length));
log({ before, secs: Math.round((Date.now() - t0) / 1000), status, after, drawerDays: drawers });
// A manned row now shows the full name.
await click('.bl-tab[data-tab="manned"]');
await sleep(300);
log({ rows: await page.evaluate(() => [...document.querySelectorAll('[data-table="manned"] .bl-row td:nth-child(2)')].slice(0, 5).map((td) => td.textContent.replace(/\s+/g, " ").trim())) });
await click('.bl-tab[data-tab="cashiers"]');
await sleep(300);
await page.screenshot({ path: `${out}/boblisa-names.png` });
log({ errors });
browser.disconnect();
