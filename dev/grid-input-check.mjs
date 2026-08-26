// dev/grid-input-check.mjs
//
// Reported 2026-08-26: the Assignments grid stops accepting hotkeys, and
// paste does nothing.
//
// Hypothesis for the hotkeys: every task set re-renders the page, innerHTML is
// replaced, focus falls to <body>, and the SECOND keypress has nowhere to go.
// So a one-key test passes while real use fails — this presses several in a
// row, which is the thing that was actually broken.
//
//   node dev/grid-input-check.mjs --build=<dir>
//
// Writes to the live database, then clears the cells it set.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (n, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const BUILD = arg("build");
const PROFILE = process.env.APAISUITE_EDGE_PROFILE || join(homedir(), ".apaisuite-edge-debug");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = null;
if (BUILD) {
  try {
    const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", "Secure Preferences"), "utf8"));
    const want = BUILD.replace(/[\\/]+/g, "\\").toLowerCase();
    for (const [k, v] of Object.entries(prefs?.extensions?.settings || {})) {
      if (String(v?.path || "").replace(/[\\/]+/g, "\\").toLowerCase() === want) id = k;
    }
  } catch {}
}

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
async function loads(c) {
  const p = await browser.newPage();
  try { await p.goto(`chrome-extension://${c}/app.html`, { waitUntil: "domcontentloaded", timeout: 12_000 }); return true; }
  catch { return false; } finally { await p.close().catch(() => {}); }
}
if (id && !(await loads(id))) id = null;
if (!id) {
  for (const t of await browser.targets()) {
    if (!t.url().startsWith("chrome-extension://")) continue;
    const c = new URL(t.url()).host;
    if (await loads(c)) { id = c; break; }
  }
}
if (!id) { console.error("✗ no loadable extension"); process.exit(1); }

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1050 });
await page.goto(`chrome-extension://${id}/app.html`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await sleep(3000);
await page.evaluate(() => {
  [...document.querySelectorAll("a,button,[role=button],li")]
    .find((e) => /digital metrics/i.test((e.textContent || "").trim()))?.click();
});
await page.waitForFunction(() => (document.querySelector("#dm-week")?.options?.length ?? 0) > 0,
  { timeout: 60_000, polling: 500 }).catch(() => {});
await sleep(2500);
await page.evaluate(() => document.querySelector('.dm-tab[data-dm-page="assignments"]')?.click());
await sleep(3000);

const cellText = () => page.evaluate(() =>
  [...document.querySelectorAll("#dm-page .dm-cell")].slice(0, 5).map((c) => c.innerText.trim()));

// ── hotkeys, several in a row ────────────────────────────────────────────
console.log("before:", JSON.stringify(await cellText()));

await page.evaluate(() => {
  const c = document.querySelector("#dm-page .dm-cell");
  c?.focus(); c?.click();
});
await sleep(500);

const keys = ["p", "d", "s"];
for (const k of keys) {
  await page.keyboard.press(k);
  await sleep(1500);
  // Move right so each key lands in its own cell — this is where focus loss
  // used to break the sequence.
  await page.keyboard.press("ArrowRight");
  await sleep(400);
}
const after = await cellText();
console.log("after keys p,d,s:", JSON.stringify(after));
const got = after.slice(0, 3).join(",");
console.log(got === "PICK,DISP,STAGE"
  ? "✓ consecutive hotkeys all landed"
  : `✗ expected PICK,DISP,STAGE — got ${got}`);

const focusOk = await page.evaluate(() =>
  document.activeElement?.classList?.contains("dm-cell") ?? false);
console.log(`focus still on a cell after edits: ${focusOk ? "✓" : "✗"}`);

// ── paste ────────────────────────────────────────────────────────────────
await page.evaluate(() => {
  const c = document.querySelector("#dm-page .dm-cell");
  c?.focus(); c?.click();
});
await sleep(500);
await page.evaluate(() => {
  const cell = document.activeElement;
  const dt = new DataTransfer();
  dt.setData("text/plain", "GMD\tIP");
  cell.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await sleep(2500);
const pasted = await cellText();
console.log("after paste GMD\\tIP:", JSON.stringify(pasted));
console.log(pasted.slice(0, 2).join(",") === "GMD,IP" ? "✓ paste filled across" : "✗ paste did not apply");

// ── clean up ─────────────────────────────────────────────────────────────
for (let i = 0; i < 3; i++) {
  await page.evaluate((n) => {
    const c = document.querySelectorAll("#dm-page .dm-cell")[n];
    c?.focus(); c?.click();
  }, i);
  await sleep(300);
  await page.keyboard.press("x");
  await sleep(900);
}
console.log("cleaned:", JSON.stringify(await cellText()));

await page.close();
browser.disconnect();
