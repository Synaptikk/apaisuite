// dev/probe-wfm-worker.mjs
//
// Dump the STRUCTURE of one entry in the Polaris scheduler's `workers` prop.
//
// probe-wfm-fiber.mjs located the real data root at
//   div.children[0].props.workers
// and reached workers[0].worker.availabilityExceptions.* — so the traversal is
// right, but no per-worker SHIFT array scored high enough to be reported. This
// asks the direct question instead of guessing: what keys does a worker entry
// actually have, and which of them hold the scheduled shifts?
//
//   node dev/probe-wfm-worker.mjs
//
// PRIVACY: structure only. Key names, types, array lengths, and a redacted
// value sketch (times/dates kept, everything else reduced to its type). No
// names, no birthDates, no ids.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const URL_ = "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler";
const OUT = resolve(HERE, "wfm-worker-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 90_000 });
console.log("→ waiting for the grid ...");
await page.waitForFunction(
  () => (document.body?.innerText || "").length > 5000,
  { timeout: 90_000, polling: 1000 },
).catch(() => {});
await sleep(6000);

const res = await page.evaluate(() => {
  const TIME_RE = /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/i;
  const DATE_RE = /\d{4}-\d{2}-\d{2}/;

  // Redacting sketch: keep the SHAPE of a value, and keep dates/times verbatim
  // because their format is the thing we need to learn. Everything else
  // collapses to a type name so no personal data leaves the page.
  const sketch = (v, depth = 0) => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) {
      if (!v.length) return "array[0]";
      return depth >= 3 ? `array[${v.length}]`
        : { __array: v.length, sample: sketch(v[0], depth + 1) };
    }
    const t = typeof v;
    if (t === "object") {
      if (depth >= 3) return "object";
      const o = {};
      for (const [k, val] of Object.entries(v).slice(0, 40)) o[k] = sketch(val, depth + 1);
      return o;
    }
    if (t === "string") {
      if (DATE_RE.test(v) || TIME_RE.test(v)) return `"${v}"`;   // format matters
      return `string(${v.length})`;
    }
    return t;
  };

  // Find the fiber node whose props carry `workers`.
  let rootFiber = null;
  for (const el of document.querySelectorAll("*")) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
    if (key) { rootFiber = el[key]; break; }
  }
  if (!rootFiber) return { error: "no react fiber" };

  let workers = null, wherePath = null, visited = 0;
  const walk = (fiber) => {
    if (!fiber || workers || visited > 60000) return;
    visited++;
    const p = fiber.memoizedProps;
    if (p && typeof p === "object" && Array.isArray(p.workers) && p.workers.length > 3) {
      workers = p.workers;
      wherePath = typeof fiber.type === "function"
        ? (fiber.type.displayName || fiber.type.name || "fn") : String(fiber.type);
      return;
    }
    walk(fiber.child); walk(fiber.sibling);
  };
  walk(rootFiber);
  if (!workers) return { error: "no props.workers found", visited };

  // Pick an entry that actually has scheduled work, not the first one (which
  // may be inactive/LOA and therefore structurally misleading).
  const jsonLen = (o) => { try { return JSON.stringify(o).length; } catch { return 0; } };
  const richest = [...workers].sort((a, b) => jsonLen(b) - jsonLen(a))[0];

  const topKeys = {};
  for (const [k, v] of Object.entries(richest || {})) {
    topKeys[k] = Array.isArray(v) ? `array[${v.length}]` : (v === null ? "null" : typeof v);
  }

  // Any array anywhere under the entry, with its key path — the shift list is
  // certainly one of these.
  const arrays = [];
  const findArrays = (o, path, depth) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      const p = `${path}.${k}`;
      if (Array.isArray(v)) {
        arrays.push({ path: p, length: v.length,
          firstKeys: v[0] && typeof v[0] === "object" ? Object.keys(v[0]).slice(0, 30) : typeof v[0] });
        if (v[0] && typeof v[0] === "object") findArrays(v[0], `${p}[0]`, depth + 1);
      } else if (v && typeof v === "object") findArrays(v, p, depth + 1);
    }
  };
  findArrays(richest, "worker", 0);

  return {
    workersCount: workers.length,
    componentName: wherePath,
    topKeys,
    arrays,
    sketch: sketch(richest),
  };
});

writeFileSync(OUT, JSON.stringify(res, null, 2));

if (res.error) console.error("✗ " + res.error + (res.visited ? ` (visited ${res.visited})` : ""));
else {
  console.log(`\n→ props.workers on <${res.componentName}>, ${res.workersCount} entries`);
  console.log(`\n  top-level keys of the richest entry:`);
  for (const [k, v] of Object.entries(res.topKeys)) console.log(`    ${k.padEnd(28)} ${v}`);
  console.log(`\n  arrays found beneath it:`);
  for (const a of res.arrays) {
    console.log(`    ${a.path.padEnd(60)} len=${String(a.length).padStart(4)}`);
    if (Array.isArray(a.firstKeys)) console.log(`        keys: ${a.firstKeys.join(", ").slice(0, 180)}`);
  }
}
console.log(`\n✓ structure-only report written to ${OUT}`);
await page.close();
browser.disconnect();
