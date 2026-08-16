// dev/test-vizpick-cache.mjs
//
// Verifies the snapshot store's roll rules against the live extension:
//   · a re-pull whose source stamp is UNCHANGED refreshes in place and must
//     NOT displace the stored history (this is the "reopening the module
//     must not overwrite today's data" requirement);
//   · a simulated NEW source stamp rolls the standing snapshot into
//     `previous` exactly once;
//   · the store is version-scoped, and a foreign version is discarded rather
//     than half-read.
//
//   node dev/test-vizpick-cache.mjs

import puppeteer from "puppeteer-core";

const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const EXT_NAME = "APAISuite";
const KEY = "vizpick.snapshots.v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });

const extPage = await browser.newPage();
await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 15_000 });
const ext = await extPage.evaluate(async (name) => {
  const list = await new Promise((r) => chrome.developerPrivate.getExtensionsInfo({}, r));
  const e = list.find((x) => x.name === name);
  return e ? { id: e.id, version: e.version } : null;
}, EXT_NAME);
await extPage.close().catch(() => {});
if (!ext) { console.error("✗ extension not found"); process.exit(1); }

const page = await browser.newPage();
await page.goto(`chrome-extension://${ext.id}/app.html#/vizpick`, { waitUntil: "domcontentloaded", timeout: 20_000 });
await sleep(2500);

const readStore = () => page.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k] || null))), KEY);
const writeStore = (v) => page.evaluate((k, val) => new Promise((r) => chrome.storage.local.set({ [k]: val }, r)), KEY, v);

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

// ── Baseline ──────────────────────────────────────────────────────────────
const s0 = await readStore();
if (!s0?.yesterday) { console.error("✗ no stored snapshot — run test-vizpick-e2e.mjs first"); process.exit(1); }
console.log(`\nbaseline: v=${s0.v} yesterdayStamp=${JSON.stringify(s0.yesterday.sourceKey)} ` +
            `rows=${s0.yesterday.rows.length} previous=${s0.previous ? "present" : "null"} ` +
            `today=${s0.today ? `${s0.today.rows.length} rows @ ${s0.today.sourceKey}` : "null"}`);

console.log("\n── schema version ──");
check("store is written under a versioned key", s0.v === 2, `got v=${s0.v}`);

// ── 1. Re-pull with an unchanged source stamp must not roll ───────────────
console.log("\n── unchanged source stamp ──");
const beforeStamp = s0.yesterday.sourceKey;
const beforePrev = JSON.stringify(s0.previous);
const beforeToday = JSON.stringify(s0.today);

console.log("  running pull_stores again (Tableau has not republished)…");
const pull = await page.evaluate((id) => new Promise((r) =>
  chrome.runtime.sendMessage(id, { module: "vizpick", type: "pull_stores" }, (resp) => r(resp || { error: chrome.runtime.lastError?.message }))
), ext.id).catch((e) => ({ error: String(e) }));
console.log(`  pull_stores → ${JSON.stringify(pull)?.slice(0, 200)}`);
await sleep(1500);

const s1 = await readStore();
check("source stamp is unchanged", s1.yesterday.sourceKey === beforeStamp, `${beforeStamp} → ${s1.yesterday.sourceKey}`);
check("no roll occurred (previous untouched)", JSON.stringify(s1.previous) === beforePrev);
check("today snapshot untouched by a yesterday re-pull", JSON.stringify(s1.today) === beforeToday);
check("rows still present", (s1.yesterday.rows?.length || 0) > 0, `${s1.yesterday.rows?.length}`);

// ── 2. A genuinely new source stamp rolls exactly once ────────────────────
console.log("\n── new source stamp rolls once ──");
// Simulate tomorrow's publish by rewriting the stored stamp to an older one,
// so the next real capture looks like an advance.
const doctored = JSON.parse(JSON.stringify(s1));
doctored.yesterday.sourceKey = "8/15/2026";
doctored.yesterday.sourceUpdate = { raw: "8/15/2026", iso: doctored.yesterday.sourceUpdate?.iso ?? null, hasTime: false };
doctored.yesterday.rows = doctored.yesterday.rows.slice(0, 3); // marker so we can spot it in `previous`
doctored.previous = null;
await writeStore(doctored);
console.log("  stored stamp doctored to 8/15/2026 with a 3-row marker");

const pull2 = await page.evaluate((id) => new Promise((r) =>
  chrome.runtime.sendMessage(id, { module: "vizpick", type: "pull_stores" }, (resp) => r(resp || { error: chrome.runtime.lastError?.message }))
), ext.id).catch((e) => ({ error: String(e) }));
console.log(`  pull_stores → ${JSON.stringify(pull2)?.slice(0, 200)}`);
await sleep(1500);

const s2 = await readStore();
check("service reported a roll", pull2?.rolled === true, JSON.stringify(pull2?.rollReason));
check("previous now holds the displaced snapshot", s2.previous?.sourceKey === "8/15/2026", `previous=${s2.previous?.sourceKey}`);
check("previous kept the 3-row marker", s2.previous?.rows?.length === 3, `${s2.previous?.rows?.length}`);
check("yesterday holds the fresh capture", s2.yesterday?.sourceKey === beforeStamp, `${s2.yesterday?.sourceKey}`);
check("yesterday has the full roster again", (s2.yesterday?.rows?.length || 0) > 3, `${s2.yesterday?.rows?.length}`);

// ── 3. A foreign schema version is discarded, not half-read ───────────────
console.log("\n── foreign schema version ──");
const saved = JSON.parse(JSON.stringify(s2));
await writeStore({ v: 99, yesterday: { sourceKey: "bogus", rows: [{ store: "X" }] }, previous: null, today: null });
const state = await page.evaluate((id) => new Promise((r) =>
  chrome.runtime.sendMessage(id, { module: "vizpick", type: "get_state" }, (resp) => r(resp || { error: chrome.runtime.lastError?.message }))
), ext.id);
check("v99 store is not surfaced as data", !state.rows?.some((r) => r.store === "X"), `rows=${state.rows?.length}`);
check("get_state reports the current schema version", state.schemaVersion === 2, `${state.schemaVersion}`);

// restore the real store so the user's module isn't left empty
await writeStore(saved);
const restored = await readStore();
check("original snapshot restored after the test", restored.yesterday?.rows?.length === s2.yesterday.rows.length);

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
browser.disconnect();
process.exit(fail === 0 ? 0 : 1);
