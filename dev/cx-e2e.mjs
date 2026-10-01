// End-to-end over the real extension in the debug Edge: reload, open the shell,
// route to Cx, run a full refresh, then read back what the panel computed.
import puppeteer from "puppeteer-core";

const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";   // APAISuite-dev mirror
const APP = `chrome-extension://${EXT}/app.html`;

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 600_000 });

// Open the replacement BEFORE reloading: chrome.runtime.reload() detaches the
// page handle it was called from, and closing the last tab exits Edge.
let page = await browser.newPage();
await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60_000 });
await new Promise(r => setTimeout(r, 2500));
await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
await new Promise(r => setTimeout(r, 3500));

page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });

await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await new Promise(r => setTimeout(r, 5000));

const mounted = await page.evaluate(() => {
  const root = document.querySelector(".module-cx .cx");
  return {
    mounted: !!root,
    store: document.querySelector("[data-store-label]")?.textContent,
    freshness: document.querySelector("[data-freshness]")?.textContent,
    panels: [...document.querySelectorAll(".module-cx section[data-]")].length,
    heading: document.querySelector(".module-cx h1")?.textContent,
  };
});
console.log("MOUNT:", JSON.stringify(mounted));
if (!mounted.mounted) { console.log("ERRORS:", errors); await browser.disconnect(); process.exit(1); }

// Full pull.
console.log("\nclicking Full pull …");
await page.click("[data-action='refresh-full']");

const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 420_000) {
  await new Promise(r => setTimeout(r, 4000));
  const s = await page.evaluate(() => ({
    label: document.querySelector("[data-action='refresh'] .btn-label")?.textContent,
    busy: document.querySelector("[data-action='refresh']")?.disabled,
    note: document.querySelector("[data-run-note]")?.textContent?.trim(),
  }));
  if (s.label !== last) { console.log(`  ${Math.round((Date.now()-t0)/1000)}s  ${s.label}`); last = s.label; }
  if (!s.busy) { console.log("  done:", s.note); break; }
}

await new Promise(r => setTimeout(r, 4000));

const result = await page.evaluate(() => {
  const txt = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
  const tiles = [...document.querySelectorAll("[data-score-row] .cx-tile")].map((el) => ({
    label: el.querySelector(".cx-tile-label")?.textContent?.trim(),
    value: el.querySelector(".cx-tile-value")?.textContent?.trim(),
    deltas: [...el.querySelectorAll(".cx-delta")].map((d) => d.textContent.trim()),
  }));
  const themes = (sel) => [...document.querySelectorAll(`${sel} .cx-theme`)].map((el) => ({
    count: el.querySelector(".cx-theme-count")?.textContent?.trim(),
    name: el.querySelector(".cx-theme-name")?.textContent?.trim().replace(/\s+/g, " "),
    split: el.querySelector(".cx-theme-splitnum")?.textContent?.trim(),
  }));
  return {
    runNote: txt("[data-run-note]"),
    freshness: txt("[data-freshness]"),
    scoreTiles: tiles,
    journeyChips: [...document.querySelectorAll("[data-journey-chips] .cx-chip")].map((c) => c.textContent.trim().replace(/\s+/g, " ")),
    channelChips: [...document.querySelectorAll("[data-channel-chips] .cx-chip")].map((c) => c.textContent.trim().replace(/\s+/g, " ")),
    filterMeta: txt("[data-filter-meta]"),
    badSub: txt("[data-bad-sub]"),
    bad: themes("[data-bad-themes]"),
    good: themes("[data-good-themes]"),
    movementSub: txt("[data-movement-sub]"),
    movers: [...document.querySelectorAll("[data-movers] .cx-mover")].map((el) => el.textContent.trim().replace(/\s+/g, " ")),
    bars: document.querySelectorAll(".cx-bar-col").length,
    legendNote: txt(".cx-legend-note"),
    comments: document.querySelectorAll(".cx-comment").length,
    commentsSub: txt("[data-comments-sub]"),
    genaiStamp: txt("[data-genai-stamp]"),
    sparkPresent: !!document.querySelector(".cx-spark path.cx-spark-ty"),
    hiddenPanels: [...document.querySelectorAll(".module-cx section[hidden]")].map((s) => s.className || s.dataset),
  };
});

console.log("\n===== PANEL =====");
console.log("run note :", result.runNote);
console.log("freshness:", result.freshness);
console.log("sparkline:", result.sparkPresent);
console.log("\nscore tiles:");
for (const t of result.scoreTiles) console.log(`  ${String(t.label).padEnd(34)} ${String(t.value).padEnd(7)} ${t.deltas.join(" | ")}`);
console.log("\njourney chips:", result.journeyChips.join(" · "));
console.log("channel chips:", result.channelChips.join(" · "));
console.log("filter meta  :", result.filterMeta);
console.log("\nwrong (", result.badSub, "):");
for (const t of result.bad) console.log(`  ${String(t.count).padStart(5)}  ${String(t.name).padEnd(34)} ${t.split}`);
console.log("\nright:");
for (const t of result.good) console.log(`  ${String(t.count).padStart(5)}  ${String(t.name).padEnd(34)} ${t.split}`);
console.log("\nmovement:", result.movementSub);
for (const m of result.movers) console.log("  " + m);
console.log("\nweekly bars:", result.bars, "|", result.legendNote);
console.log("comments   :", result.comments, "|", result.commentsSub);
console.log("genai stamp:", result.genaiStamp);
console.log("hidden panels:", JSON.stringify(result.hiddenPanels));
console.log("\nERRORS:", errors.length ? errors : "none");

await page.screenshot({ path: process.env.SHOT || "cx-e2e.png", fullPage: true });
console.log("shot ->", process.env.SHOT || "cx-e2e.png");
await browser.disconnect();
