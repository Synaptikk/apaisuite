// dev/probe-wfm-filters.mjs
//
// Where does the Polaris scheduler keep its FILTER and WEEK state, and can a
// background tab be forced to a known scope?
//
// Reported 2026-08-25: a pull opened the scheduler and it came up carrying the
// analyst's previously-chosen filters. That matters more than it sounds —
// lib/sources/wfm_schedule.js reads `props.workers`, which is the FILTERED
// list. A persisted workgroup/team/role filter therefore yields a partial
// roster that is written to Firestore and reported as a complete week, with
// nothing anywhere saying it was partial.
//
// This probe answers three things:
//   1. Is the scope in the URL, in storage, or only server-side per user?
//   2. Can it be read, so a pull can at least REFUSE to store a filtered week?
//   3. Is there a "Clear filters" control a pull could drive first?
//
//   node dev/probe-wfm-filters.mjs
//
// PRIVACY: prints counts, labels, control names and storage KEYS. Storage
// values are reported by length and type only, never contents — the portal's
// session blobs contain personal data.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const URL_ = "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler";
const OUT = resolve(HERE, "wfm-filters-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || "").length > 5000,
  { timeout: 90_000, polling: 1000 }).catch(() => {});
await sleep(7000);

const res = await page.evaluate(() => {
  const text = document.body?.innerText || "";

  // ── roster count as the page states it, vs what props.workers holds ────
  // A mismatch is the cheapest possible "you are looking at a filtered view"
  // signal, and it needs no knowledge of which filter is applied.
  const rosterLabel = (text.match(/Roster\s*\((\d+)\)/i) || [])[1] || null;

  let workers = null, visited = 0;
  const walk = (f) => {
    if (!f || workers || visited > 60000) return;
    visited++;
    const p = f.memoizedProps;
    if (p && typeof p === "object" && Array.isArray(p.workers) && p.workers.length > 3) { workers = p.workers; return; }
    walk(f.child); walk(f.sibling);
  };
  for (const el of document.querySelectorAll("*")) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (k) { walk(el[k]); break; }
  }

  // ── week indicator ─────────────────────────────────────────────────────
  const weekLabel = (text.match(/\bWK\s*(\d+)\b/i) || [])[0] || null;
  const isCurrent = /\bCurrent\b/.test(text);

  // ── filter controls ────────────────────────────────────────────────────
  const controls = [];
  for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [class*="chip"], [class*="filter"]')) {
    const label = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    if (!label || label.length > 40) continue;
    if (!/filter|workgroup|team|role|clear|week|current|minor|available|opening|mid|closing|overnight|fixed/i.test(label)) continue;
    controls.push({
      label,
      tag: el.tagName.toLowerCase(),
      pressed: el.getAttribute("aria-pressed"),
      selected: el.getAttribute("aria-selected"),
      disabled: el.disabled ?? null,
      testId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || null,
    });
  }

  // ── storage keys (names + sizes only) ──────────────────────────────────
  const keysOf = (store) => {
    const out = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        const v = store.getItem(k);
        out.push({ key: k, bytes: v ? v.length : 0,
                   looksScopeish: /filter|workgroup|team|role|week|scope|scheduler/i.test(k) });
      }
    } catch {}
    return out;
  };

  return {
    url: location.href,
    hasQuery: location.search.length > 1 || location.hash.length > 1,
    rosterLabel: rosterLabel ? Number(rosterLabel) : null,
    workersLength: workers ? workers.length : null,
    weekLabel, isCurrent,
    controls: controls.slice(0, 40),
    localStorage: keysOf(window.localStorage),
    sessionStorage: keysOf(window.sessionStorage),
  };
});

writeFileSync(OUT, JSON.stringify(res, null, 2));

console.log(`\n→ url: ${res.url}`);
console.log(`   query/hash present: ${res.hasQuery}`);
console.log(`   week label: ${res.weekLabel}   "Current" on page: ${res.isCurrent}`);
console.log(`\n→ roster label says: ${res.rosterLabel}`);
console.log(`   props.workers holds: ${res.workersLength}`);
if (res.rosterLabel != null && res.workersLength != null) {
  console.log(res.rosterLabel === res.workersLength
    ? "   ✓ MATCH — this view is unfiltered"
    : `   ✗ MISMATCH — ${res.rosterLabel - res.workersLength} workers are being hidden by a filter`);
}

console.log(`\n→ scope-ish controls:`);
for (const c of res.controls) {
  const st = [c.pressed && `pressed=${c.pressed}`, c.selected && `selected=${c.selected}`].filter(Boolean).join(" ");
  console.log(`   ${c.label.padEnd(24)} ${c.tag}${st ? "  " + st : ""}${c.testId ? "  #" + c.testId : ""}`);
}

const scopeKeys = [...res.localStorage, ...res.sessionStorage].filter((k) => k.looksScopeish);
console.log(`\n→ storage keys that look like scope state (${scopeKeys.length}):`);
for (const k of scopeKeys) console.log(`   ${k.key}  (${k.bytes} bytes)`);
console.log(`   [total keys: local ${res.localStorage.length}, session ${res.sessionStorage.length}]`);

console.log(`\n✓ written to ${OUT}`);
await page.close();
browser.disconnect();
