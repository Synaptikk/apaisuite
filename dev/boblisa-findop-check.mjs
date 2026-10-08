// dev/boblisa-findop-check.mjs — the training-receipt "Find operator in EJ" lookup.
// 1) find_operator on a known pair's first transaction (reg/date/time) must list
//    that pair's op + TR# at Δ0. 2) Open a manual-cashier training form (if the
//    range has one), enter reg/date/time, click Find, pick, screenshot. Nothing saved.
// Usage: node dev/boblisa-findop-check.mjs <outdir>   (mirror modules/boblisa into APAISuite-dev first)
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 300000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await sleep(4000);
page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1100 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
await page.goto(`chrome-extension://${EXT}/app.html#/boblisa`, { waitUntil: "domcontentloaded" });
await sleep(3000);
const send = (type, payload) => page.evaluate((type, payload) => new Promise((res) => chrome.runtime.sendMessage({ module: "boblisa", type, ...payload }, res)), type, payload);

const st = await send("get_state", {});
const s = st?.data || st;
const pair = (s.pairs || []).find((p) => p.category === "manned");
console.log(JSON.stringify({ pairs: s.pairs?.length, trainings: s.trainings?.length, sample: pair && { date: pair.date, reg: pair.t1.reg, time: pair.t1.time, op: pair.t1.op, tr: pair.t1.tr } }));
if (pair) {
  const t0 = Date.now();
  const r = await send("find_operator", { date: pair.date, reg: pair.t1.reg, time: pair.t1.time });
  const d = r?.data || r;
  console.log("find_operator", Date.now() - t0, "ms", JSON.stringify({ ok: d.ok, error: d.error, records: d.records, candidates: (d.candidates || []).map((c) => `${c.time} Δ${c.deltaSec} op ${c.op} ${c.name} TR ${c.tr} ${c.items}i ${c.total}`) }));
  const hit = (d.candidates || []).find((c) => String(c.tr) === String(pair.t1.tr) && String(c.op) === String(pair.t1.op) && c.deltaSec === 0);
  console.log(hit ? "PASS: pair's own first transaction found at Δ0" : "FAIL: pair's first transaction not in candidates");
  const bad = await send("find_operator", { date: pair.date, reg: "", time: pair.t1.time });
  console.log("validation:", (bad?.data || bad).error);
}

// UI: a paid training card without a same-card earlier sale.
const opened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".bl-tcard .bl-doc-open")].find((b) => b.closest(".bl-tcard").textContent.includes("No earlier same-card sale"));
  if (!btn) return false; btn.click(); return true;
});
console.log("manual training form:", opened);
if (opened && pair) {
  await sleep(500);
  await page.evaluate((p) => {
    const f = document.querySelector(".bl-tcard [data-docform]");
    f.t1reg.value = p.t1.reg; f.t1date.value = p.date; f.t1time.value = p.t1.time;
    f.querySelector(".bl-find-op").click();
  }, pair);
  for (let i = 0; i < 40 && !(await page.$(".bl-pick-op")); i++) await sleep(1000);
  console.log("list:", await page.evaluate(() => document.querySelector("[data-opfind]")?.textContent.replace(/\s+/g, " ").slice(0, 400)));
  if (await page.$(".bl-pick-op")) {
    await page.click(".bl-pick-op");
    await sleep(300);
    console.log("filled:", JSON.stringify(await page.evaluate(() => { const f = document.querySelector(".bl-tcard [data-docform]"); return { op: f.t1op.value, reg: f.t1reg.value, name: f.cashierName.value, note: f.note.value }; })));
  }
  const form = await page.$(".bl-tcard [data-docform]");
  await form.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${out}/boblisa-findop.png` });
}
console.log(JSON.stringify({ errors }));
await page.close();
browser.disconnect();
