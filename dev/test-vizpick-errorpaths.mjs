// dev/test-vizpick-errorpaths.mjs
//
// The happy-path e2e never renders the error panel, because paintDebug()
// returns early when the last capture succeeded. That blind spot let a
// temporal-dead-zone bug ship: `const FIXES` was declared inside mount()
// below the first paint(), so the module threw "Cannot access 'FIXES' before
// initialization" — but ONLY for a user who already had a failed capture
// stored.
//
// This drives every failure class through the real UI and asserts the module
// still mounts and produces an actionable message.
//
//   node dev/test-vizpick-errorpaths.mjs

import puppeteer from "puppeteer-core";

const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const EXT_NAME = "APAISuite";
const DEBUG_KEY = "vizpick.debug.stores";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLASSES = [
  ["AUTH", "Tableau is showing a sign-in / SSO page, so no data could be read."],
  ["SLOW_RENDER", "Tableau was still rendering after 120s."],
  ["WRONG_VIEW", 'The Tableau tab is on "https://example/other", not the VizPick summary view.'],
  ["NO_CONTENT_SCRIPT", "The capture content script was not present on the Tableau tab."],
  ["TABLEAU_ERROR", "Tableau reported an error on the page instead of rendering the viz."],
  ["EXPORT_UI", "Could not drive crosstab export: sheet not found"],
  ["NO_CAPTURE", "No CSV containing \"Cases Seen %\" captured within 45000ms."],
  ["PARSE", "Store CSV parse failed: unexpected columns"],
  ["SESSION", "Tableau viz did not render within 120s."],
  ["TAB", "Could not open Tableau VizPick tab."],
  // A class with no entry in FIXES must still render, just without the hint.
  ["SOME_UNKNOWN_CLASS", "an error class the UI has never heard of"],
];

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
const extPage = await browser.newPage();
await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 15_000 });
const ext = await extPage.evaluate(async (name) => {
  const l = await new Promise((r) => chrome.developerPrivate.getExtensionsInfo({}, r));
  return l.find((x) => x.name === name)?.id || null;
}, EXT_NAME);
await extPage.evaluate((id) => new Promise((r) => chrome.developerPrivate.reload(id, {}, r)), ext);
await extPage.close().catch(() => {});
await sleep(2500);
console.log(`✓ reloaded ${EXT_NAME} (${ext})`);

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

// Preserve whatever the user actually had stored.
await page.goto(`chrome-extension://${ext}/app.html#/vizpick`, { waitUntil: "domcontentloaded", timeout: 20_000 });
await sleep(2000);
const saved = await page.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k] ?? null))), DEBUG_KEY);

for (const [errorClass, error] of CLASSES) {
  const errors = [];
  page.removeAllListeners("pageerror");
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.evaluate((k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r)), DEBUG_KEY, {
    ok: false,
    errorClass,
    error,
    debug: { tabUrl: "https://stores.tableau.wal-mart.com/#/x", page: { installed: false, testIdCount: 0 } },
    capturedAt: new Date().toISOString(),
  });

  // Full reload so mount() runs from scratch with the error already stored —
  // that is the exact ordering that triggered the TDZ crash.
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2200);

  const ui = await page.evaluate(() => {
    const sec = document.querySelector("[data-debug-section]");
    return {
      mounted: !!document.querySelector(".vizpick"),
      debugVisible: !!sec && !sec.hidden,
      code: document.querySelector("[data-debug-body] code")?.textContent?.trim() || null,
      fix: document.querySelector(".vizpick-debug-fix")?.textContent?.trim() || null,
      loadError: document.body.innerText.includes("Failed to load module") ? document.body.innerText.slice(0, 160) : null,
    };
  });

  const expectFix = errorClass !== "SOME_UNKNOWN_CLASS";
  console.log(`\n${errorClass}:`);
  check("module mounted", ui.mounted, ui.loadError || "");
  check("no page error thrown", errors.length === 0, errors[0] || "");
  check("error panel visible", ui.debugVisible);
  check("error class shown", ui.code === errorClass, `got ${ui.code}`);
  check(expectFix ? "actionable 'What to do' shown" : "unknown class degrades gracefully (no hint)",
        expectFix ? !!ui.fix : ui.fix === null, JSON.stringify(ui.fix)?.slice(0, 90));
}

// Restore
await page.evaluate((k, v) => new Promise((r) => (v === null ? chrome.storage.local.remove(k, r) : chrome.storage.local.set({ [k]: v }, r))), DEBUG_KEY, saved);
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(1500);
const restored = await page.evaluate(() => !!document.querySelector(".vizpick"));
console.log("");
check("original debug state restored and module still mounts", restored);

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
browser.disconnect();
process.exit(fail === 0 ? 0 : 1);
