// dev/boblisa-names-check.mjs — reload, Re-pull all (fills boblisa.operators.<store> from
// sign-on banners), open the first manned row's form: name prefilled from the journal,
// one-line note that follows the Cause select, no overlapping controls. Nothing is saved.
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 600000 });
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
const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error("no element " + s); el.click(); }, sel);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
await sleep(3000);
await click("#boblisa-repull");
for (let i = 0; i < 90; i++) { await sleep(4000); const prog = await text("#boblisa-progress"); if (!prog && i > 1) break; }
const ops = await page.evaluate(() => chrome.storage.local.get("boblisa.operators.1458").then((r) => r["boblisa.operators.1458"]?.names || {}));
log({ operators: Object.keys(ops).length, sample: Object.entries(ops).slice(0, 5) });
await click('.bl-tab[data-tab="manned"]');
// First manned row whose op has a name, else the first row.
const key = await page.evaluate((names) => { const rows = [...document.querySelectorAll('[data-table="manned"] .bl-row')]; const r = rows.find((x) => /op (\d+)/.test(x.textContent) && names[x.textContent.match(/op (\d+)/)[1]]) || rows[0]; return r?.dataset.key; }, ops);
await page.evaluate((k) => document.querySelector(`[data-table="manned"] .bl-row[data-key="${k}"]`).click(), key);
await sleep(300);
const rowText = await text(`[data-table="manned"] .bl-row[data-key="${key}"] td:nth-child(2)`);
await click(".bl-doc-open");
await sleep(300);
const form = () => page.evaluate(() => { const f = document.querySelector("[data-docform]"); return { cause: f.cause.value, name: f.cashierName.value, note: f.note.value, title: f.cashierName.title }; });
const before = await form();
await page.evaluate(() => { const f = document.querySelector("[data-docform]"); f.cause.value = "inside_item"; f.cause.dispatchEvent(new Event("input", { bubbles: true })); });
const afterCause = await form();
await page.evaluate(() => { const f = document.querySelector("[data-docform]"); f.cashierName.value = "Jane Doe"; f.cashierName.dispatchEvent(new Event("input", { bubbles: true })); });
const afterName = await form();
await page.evaluate(() => { const f = document.querySelector("[data-docform]"); f.note.value += " edited"; f.note.dispatchEvent(new Event("input", { bubbles: true })); f.cause.value = "bottom_of_basket"; f.cause.dispatchEvent(new Event("input", { bubbles: true })); });
const afterEdit = await form();
// Overlap: every control's right edge must stay inside its label cell.
const overlap = await page.evaluate(() => [...document.querySelectorAll("[data-docform] .bl-field")].map((l) => { const c = l.querySelector("select, input, textarea"); const a = l.getBoundingClientRect(), b = c.getBoundingClientRect(); return { field: l.textContent.trim().slice(0, 12), spill: Math.round(b.right - a.right) }; }));
await page.evaluate(() => document.querySelector("[data-docform]").scrollIntoView({ block: "center" }));
await sleep(200);
await page.screenshot({ path: `${out}/boblisa-form.png` });
await click(".bl-doc-cancel");
log({ key, rowText, before, afterCause: afterCause.note, afterName: afterName.note, afterEdit: afterEdit.note, overlap, errors });
browser.disconnect();
