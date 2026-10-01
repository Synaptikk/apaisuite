// dev/orcmonitor-e2e.mjs
// Live check of the ORC Corridor Monitor in the debug Edge (CDP :9222), which
// loads the APAISuite-dev mirror — copy modules/orcmonitor there first.
//
//   node dev/orcmonitor-e2e.mjs [store=1458] [days=30] [shotDir]
//
// Reloads the extension, opens #/orcmonitor, checks the USGS basemap tiles
// actually load, runs Analyze and prints the panels. Leaves the tab open.

import puppeteer from "puppeteer-core";

const EXT_ID = "fchnolphfaklbpdgnofhblfhcailkpdb";
const APP = `chrome-extension://${EXT_ID}/app.html`;
const STORE = process.argv[2] ?? "1458";
const DAYS = process.argv[3] ?? "30";
const SHOT_DIR = process.argv[4] ?? ".";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600_000 });
let page = (await browser.pages()).find(p => p.url().startsWith(APP));
if (!page) { // Background tab: the debug Edge is the user's everyday browser, so don't
// pull focus away from whatever they are doing in it.
{
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", { url: `${APP}#/orcmonitor`, background: true });
  const target = await browser.waitForTarget(t => t._targetId === targetId || t._getTargetInfo?.().targetId === targetId);
  page = await target.page();
} await page.goto(APP, { waitUntil: "domcontentloaded" }); }

// Reload tears down every extension page; open the test tab only after it
// has finished (a tab opened before the reload got closed mid-run). Other
// tabs stay open, so Edge never loses its last window.
if (!process.env.NO_RELOAD) {
  log("reloading extension");
  await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(5000);
}
// Background tab: the debug Edge is the user's everyday browser, so don't
// pull focus away from whatever they are doing in it.
{
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", { url: `${APP}#/orcmonitor`, background: true });
  const target = await browser.waitForTarget(t => t._targetId === targetId || t._getTargetInfo?.().targetId === targetId);
  page = await target.page();
}
page.on("close", () => log("!! test tab closed"));
page.on("framenavigated", f => { if (f === page.mainFrame()) log("nav", f.url().slice(0, 90)); });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", e => errors.push("pageerror: " + String(e.message).slice(0, 200)));
await page.waitForSelector("#om-store", { timeout: 30_000 });
await sleep(5000);

const tiles = await page.evaluate(() => {
  const t = [...document.querySelectorAll("#om-map img.leaflet-tile")];
  return { total: t.length, loaded: t.filter(i => i.complete && i.naturalWidth).length,
           host: t[0] ? new URL(t[0].src).host : null,
           note: document.querySelector("#om-map-note:not(.hidden)")?.textContent ?? null,
           vectors: document.querySelectorAll("#om-map canvas").length };
});
log("tiles", JSON.stringify(tiles));

await page.evaluate((s, d) => {
  document.querySelector("#om-store").value = s;
  document.querySelector(`.om-days-btn[data-days="${d}"]`)?.click();
}, STORE, DAYS);
log("waiting for Auror token");
await page.waitForFunction(() => !document.querySelector("#om-btn-analyze").disabled, { timeout: 120_000 });
await page.click("#om-btn-analyze");
const t0 = Date.now();
for (;;) {
  await sleep(15_000);
  const st = await page.evaluate(() => ({ btn: document.querySelector("#om-btn-analyze").textContent,
                                          label: document.querySelector("#om-progress-label").textContent }));
  log(st.label);
  if (st.btn === "Analyze" || Date.now() - t0 > 590_000) break;
}

const out = await page.evaluate(async () => {
  const text = sel => document.querySelector(sel)?.innerText.replace(/\s+\n/g, "\n").trim() ?? "";
  const res = { pills: text("#om-summary-pills") };
  for (const tab of ["stores", "groups", "people"]) {
    document.querySelector(`.om-tab[data-tab="${tab}"]`).click();
    await new Promise(r => setTimeout(r, 400));
    res[tab] = text("#om-panel").slice(0, 1800);
  }
  document.querySelector('.om-tab[data-tab="groups"]').click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector(".om-group[data-kind]")?.click();   // draw the first group's route
  await new Promise(r => setTimeout(r, 1500));
  return res;
});
console.log("\n== PILLS ==\n" + out.pills + "\n\n== STORES ==\n" + out.stores + "\n\n== GROUPS ==\n" + out.groups + "\n\n== PEOPLE ==\n" + out.people.slice(0, 600));
await page.screenshot({ path: `${SHOT_DIR}/orcmonitor-e2e.png` });

// Market brief: render it without the print dialog, save a PDF copy.
await page.evaluate(() => chrome.storage.session.set({ "orcmonitor.report_noprint": true }));
const reportTarget = browser.waitForTarget(t => t.url().includes("modules/orcmonitor/report.html"), { timeout: 120_000 });
await page.click("#om-btn-export");
const report = await (await reportTarget).page();
await report.waitForSelector("body[data-ready]", { timeout: 60_000 });
const brief = await report.evaluate(() => ({
  title: document.title,
  bottomLine: document.querySelector(".bl")?.innerText.slice(0, 700),
  impacts: document.querySelectorAll(".blk .tbl tbody tr").length,
  dossiers: document.querySelectorAll(".dos").length,
  photos: [...document.querySelectorAll(".ph img")].map(i => i.naturalWidth > 0).reduce((a, ok) => (a[ok ? "ok" : "bad"]++, a), { ok: 0, bad: 0 }),
  inlinePhotos: [...document.querySelectorAll(".ph img")].filter(i => i.src.startsWith("data:")).length,
  map: !!document.querySelector("img.map"),
}));
console.log("\n== BRIEF ==\n" + JSON.stringify(brief, null, 1));
await report.pdf({ path: `${SHOT_DIR}/orcmonitor-brief.pdf`, format: "letter", printBackground: true,
                   margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" } }).catch(e => log("pdf:", e.message));
await report.close();
log("errors:", errors.length ? "\n  " + errors.slice(0, 10).join("\n  ") : "none");
browser.disconnect();
