// dev/probe-wfm-fiber.mjs
//
// Find where the Polaris scheduler actually keeps SHIFTS.
//
// dev/probe-wfm-schedule.mjs proved the donor's extractor grabs the wrong
// array: its fiber walk accepts the first "array of >=5 people-shaped objects"
// it meets, which on this page is `workers` — the roster. It returns 351
// associates and 0 shifts, every time, and has evidently been doing so for a
// while (the donor's own [4AM DEBUG] lines report 0 too).
//
// So: walk the fiber tree and CLASSIFY every candidate array by what its
// objects actually contain, rather than stopping at the first plausible one.
//
//   node dev/probe-wfm-fiber.mjs
//
// PRIVACY: prints STRUCTURE ONLY — key names, types, counts, and value shapes.
// Never prints a name, a birthDate, or a raw record. The JSON it writes is
// structure-only too, so unlike wfm-schedule-probe.json it is safe to read.
//
// Requires Edge on a CDP port: ./dev/launch-edge-debug.sh

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const URL_ = "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler";
const OUT = resolve(HERE, "wfm-fiber-probe.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}`); process.exit(1); });
console.log("✓ attached");

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 90_000 });
console.log("→ waiting for the grid to render ...");
await page.waitForFunction(
  () => (document.body?.innerText || "").length > 5000 && document.querySelectorAll('[class*="row"], tr').length > 5,
  { timeout: 90_000, polling: 1000 },
).catch(() => {});
await sleep(6000);

const found = await page.evaluate(() => {
  // ── shape description, never values ────────────────────────────────────
  const TIME_RE = /\b\d{1,2}:\d{2}\s*(am|pm)?\b/i;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

  const describe = (v) => {
    if (v === null) return "null";
    if (Array.isArray(v)) return `array[${v.length}]`;
    const t = typeof v;
    if (t !== "string") return t;
    if (DATE_RE.test(v)) return "isoDateish";
    if (TIME_RE.test(v)) return "timeish";
    return "string";
  };

  const shapeOf = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = describe(v);
    return out;
  };

  // Does this object look like a SHIFT rather than a person?
  const shiftScore = (o) => {
    if (!o || typeof o !== "object") return 0;
    const keys = Object.keys(o).map((k) => k.toLowerCase());
    let s = 0;
    for (const k of keys) {
      if (/^(start|end)(time|date|datetime|at)?$/.test(k)) s += 3;
      if (/shift/.test(k)) s += 3;
      if (/^date$/.test(k) || /businessdate|scheduleddate/.test(k)) s += 2;
      if (/duration|hours|minutes/.test(k)) s += 1;
      if (/job|position|role|department/.test(k)) s += 1;
      if (/workerid|associateid|employeeid/.test(k)) s += 1;
    }
    for (const v of Object.values(o)) {
      if (typeof v === "string" && (TIME_RE.test(v) || DATE_RE.test(v))) s += 1;
    }
    return s;
  };

  const roots = [];
  for (const el of document.querySelectorAll("*")) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
    if (key) { roots.push(el[key]); break; }
  }
  if (!roots.length) return { error: "no react fiber found" };

  const results = [];
  const seenArrays = new WeakSet();
  let visited = 0;
  const MAX = 40000;

  const consider = (path, arr) => {
    if (!Array.isArray(arr) || arr.length < 3 || seenArrays.has(arr)) return;
    const objs = arr.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (objs.length < 3) return;
    seenArrays.add(arr);
    const score = Math.max(...objs.slice(0, 10).map(shiftScore));
    if (score < 3) return;
    results.push({
      path, length: arr.length, score,
      keys: Object.keys(objs[0]).slice(0, 40),
      shape: shapeOf(objs[0]),
    });
  };

  const search = (obj, path, depth) => {
    if (!obj || typeof obj !== "object" || depth > 6 || visited > MAX) return;
    visited++;
    for (const [k, v] of Object.entries(obj)) {
      if (visited > MAX) return;
      if (Array.isArray(v)) { consider(`${path}.${k}`, v); if (depth < 4) search(v[0], `${path}.${k}[0]`, depth + 1); }
      else if (v && typeof v === "object") search(v, `${path}.${k}`, depth + 1);
    }
  };

  const walk = (fiber, depth = 0) => {
    if (!fiber || visited > MAX) return;
    visited++;
    const name = typeof fiber.type === "function"
      ? (fiber.type.displayName || fiber.type.name || "fn")
      : (typeof fiber.type === "string" ? fiber.type : "?");
    for (const props of [fiber.memoizedProps, fiber.memoizedState]) {
      if (props && typeof props === "object") search(props, name, 0);
    }
    walk(fiber.child, depth + 1);
    walk(fiber.sibling, depth);
  };
  walk(roots[0]);

  results.sort((a, b) => b.score - a.score || b.length - a.length);
  // Dedupe by the key signature so the same array reached by several paths
  // does not fill the report.
  const seenSig = new Set();
  const unique = [];
  for (const r of results) {
    const sig = r.keys.join(",") + "|" + r.length;
    if (seenSig.has(sig)) continue;
    seenSig.add(sig); unique.push(r);
  }
  return { visited, candidates: unique.slice(0, 25) };
});

writeFileSync(OUT, JSON.stringify(found, null, 2));

if (found.error) { console.error("✗ " + found.error); }
else {
  console.log(`\n→ walked ${found.visited} nodes, ${found.candidates.length} shift-shaped candidates:\n`);
  for (const c of found.candidates) {
    console.log(`  score ${String(c.score).padStart(2)}  len ${String(c.length).padStart(5)}  ${c.path}`);
    console.log(`      keys: ${c.keys.join(", ").slice(0, 200)}`);
    const timeish = Object.entries(c.shape).filter(([, v]) => v === "timeish" || v === "isoDateish");
    if (timeish.length) console.log(`      date/time fields: ${timeish.map(([k, v]) => `${k}:${v}`).join(", ")}`);
    console.log();
  }
}
console.log(`✓ structure-only report written to ${OUT}`);
await page.close();
browser.disconnect();
