// dev/probe-wfm-schedule.mjs
//
// Run the DONOR's Polaris schedule extractor once, live, to find out which of
// its three strategies actually wins — before deciding how much of its
// fallback machinery is worth porting.
//
// The donor is the unpacked extension "Digital Metrics Data Scraper" v4.6.2 at
// C:\Users\<user>\Downloads\DMtool. Its popup.js::polarisExtractSchedule tries,
// in order: a React fiber-tree walk, a DOM scan, and a slow-scroll capture,
// and reports which one produced the rows via `data.method`. The version banner
// ("DOM extraction + 4am debug") suggests the fiber walk is not the one that
// usually lands.
//
// This does NOT reimplement it — it lifts the function source straight out of
// popup.js by name and evaluates it in the page, so what runs here is exactly
// what runs in the donor.
//
//   node dev/probe-wfm-schedule.mjs --store=1458
//
// PRIVACY: the result contains real associate names. They are written only to
// *-probe.json (gitignored) and are REDACTED in console output — initials
// only. Do not paste raw output into anything shared.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const STORE = arg("store", "1458");
const DONOR = arg("donor", join(homedir(), "Downloads", "DMtool", "popup.js"));

const URL_ = "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler";
const OUT  = resolve(HERE, "wfm-schedule-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(DONOR)) {
  console.error(`✗ donor popup.js not found at ${DONOR}\n  Pass --donor=<path to popup.js>`);
  process.exit(1);
}

// ── lift polarisExtractSchedule out of the donor by brace-matching ────────
const src = readFileSync(DONOR, "utf8");
const start = src.indexOf("function polarisExtractSchedule");
if (start < 0) { console.error("✗ polarisExtractSchedule not found in donor"); process.exit(1); }
let depth = 0, end = -1, seen = false;
for (let i = src.indexOf("{", start); i < src.length; i++) {
  if (src[i] === "{") { depth++; seen = true; }
  else if (src[i] === "}") { depth--; if (seen && depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error("✗ could not brace-match the function body"); process.exit(1); }
const FN_SRC = src.slice(start, end);
console.log(`✓ lifted polarisExtractSchedule (${FN_SRC.length} chars) from ${DONOR}`);

const out = { store: STORE, url: URL_, donor: DONOR, startedAt: new Date().toISOString() };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}\n  Run ./dev/launch-edge-debug.sh`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 90_000 });

// ── the donor's own readiness check ───────────────────────────────────────
console.log("→ waiting for the scheduler to be ready ...");
let status = null;
const dl = Date.now() + 60_000;
while (Date.now() < dl) {
  status = await page.evaluate(() => {
    try {
      const hasScheduleTable = document.querySelector('[class*="schedule"], [class*="grid"], table');
      const hasAssociates = document.querySelectorAll('[class*="row"], tr').length > 5;
      const pageText = document.body?.innerText || "";
      return {
        ready: document.readyState === "complete" && (hasScheduleTable || hasAssociates) && pageText.length > 1000,
        rowCount: document.querySelectorAll('[class*="row"], tr').length,
        pageLength: pageText.length,
        url: location.href,
        title: document.title,
      };
    } catch (e) { return { ready: false, error: String(e?.message ?? e) }; }
  }).catch(() => null);
  if (status?.ready) break;
  await sleep(1500);
}
out.readiness = status;
console.log(`   ready=${status?.ready} rows=${status?.rowCount} pageLen=${status?.pageLength}`);
console.log(`   url=${status?.url}`);
save();

if (!status?.ready) {
  console.error("\n✗ scheduler never became ready.");
  console.error("  If the url above is a sign-in page, complete SSO in the debug Edge window and re-run.");
  save(); await page.close(); browser.disconnect(); process.exit(2);
}

// ── run the donor's extractor verbatim ────────────────────────────────────
console.log("\n→ running the donor extractor (it sleeps 5s internally, plus scroll passes) ...");
const result = await page.evaluate(async (fnSrc, store) => {
  const fn = (0, eval)(`(${fnSrc})`);
  return await fn(store);
}, FN_SRC, STORE).catch((e) => ({ success: false, error: String(e?.message ?? e) }));

out.result = result;
save();

// ── report, with names redacted ───────────────────────────────────────────
const redact = (n) => String(n || "").split(/\s+/).map((w) => (w[0] || "?") + ".").join(" ");

console.log(`\n→ success: ${result?.success}`);
if (result?.error) console.log(`   error: ${result.error}`);
if (result?.data) {
  const d = result.data;
  console.log(`   method:        ${d.method}      ← which strategy actually won`);
  console.log(`   store:         ${d.store}`);
  console.log(`   weekStart:     ${d.weekStart}`);
  console.log(`   associates:    ${d.capturedCount}`);
  console.log(`   dateHeaders:   ${JSON.stringify((d.dateHeaders || []).slice(0, 10))}`);

  const withShifts = (d.associates || []).filter((a) => Object.keys(a.shifts || {}).length);
  console.log(`   with shifts:   ${withShifts.length} / ${(d.associates || []).length}`);

  const shiftKeys = new Set();
  for (const a of d.associates || []) for (const k of Object.keys(a.shifts || {})) shiftKeys.add(k);
  console.log(`   shift keys:    ${JSON.stringify([...shiftKeys].slice(0, 14))}`);

  console.log(`\n   sample (names redacted):`);
  for (const a of withShifts.slice(0, 5)) {
    const s = Object.entries(a.shifts).slice(0, 4)
      .map(([k, v]) => `${k}=${v?.start ?? "?"}-${v?.end ?? "?"}`).join("  ");
    console.log(`     ${redact(a.name).padEnd(12)} ${s}`);
  }

  // The clamp in the donor's parseTime is Math.max(0, hours - 5), so anything
  // before 5am lands on slot 0 alongside a genuine 5am start. Count them.
  let early = 0;
  for (const a of d.associates || []) {
    for (const v of Object.values(a.shifts || {})) {
      const m = String(v?.start || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
      if (!m) continue;
      let h = parseInt(m[1], 10);
      const p = (m[3] || "").toLowerCase();
      if (p === "pm" && h < 12) h += 12;
      if (p === "am" && h === 12) h = 0;
      if (h < 5) early++;
    }
  }
  console.log(`\n   shifts starting before 5am: ${early}  ← these all collapse onto slot 0`);
}

if (result?.log) {
  console.log(`\n→ donor log (last 12 lines):`);
  result.log.slice(-12).forEach((l) => console.log(`     ${String(l).slice(0, 160)}`));
}

console.log(`\n✓ written to ${OUT} (contains real names — gitignored)`);
await page.close();
browser.disconnect();
