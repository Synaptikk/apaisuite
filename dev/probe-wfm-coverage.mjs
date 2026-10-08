// dev/probe-wfm-coverage.mjs — structure of availability records + the coverage
// graph's data on the OPEN scheduler tab (does not navigate). Redacted sketch.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = (await browser.pages()).find((p) => p.url().includes("polaris.walmart.com/scheduler"));
if (!page) { console.error("no scheduler tab"); process.exit(1); }
const res = await page.evaluate(() => {
  const D = /\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}/;
  const sk = (v, d = 0) => {
    if (v == null) return String(v);
    if (Array.isArray(v)) return v.length ? (d >= 4 ? `array[${v.length}]` : { __array: v.length, s: sk(v[0], d + 1) }) : "array[0]";
    if (typeof v === "object") { if (d >= 4) return "object"; const o = {}; for (const [k, x] of Object.entries(v).slice(0, 40)) o[k] = sk(x, d + 1); return o; }
    if (typeof v === "string") return D.test(v) || v.length < 12 && /^[A-Z_ ]+$/.test(v) ? `"${v}"` : `string(${v.length})`;
    return typeof v === "number" ? v : typeof v;
  };
  let root = null;
  for (const el of document.querySelectorAll("*")) { const k = Object.keys(el).find((k) => k.startsWith("__reactFiber")); if (k) { root = el[k]; break; } }
  let workers = null; const hits = []; let n = 0;
  const RE = /coverage|demand|forecast|staff|chart|graph|curve|required|optimal|headcount|interval/i;
  const stack = [root];
  while (stack.length && n < 80000) {
    const f = stack.pop(); if (!f) continue; n++;
    const p = f.memoizedProps;
    if (p && typeof p === "object") {
      if (!workers && Array.isArray(p.workers) && p.workers.length > 3) workers = p.workers;
      const keys = Object.keys(p).filter((k) => RE.test(k) && p[k] && typeof p[k] === "object");
      if (keys.length && hits.length < 25) hits.push({ comp: typeof f.type === "function" ? (f.type.displayName || f.type.name) : String(f.type), keys: Object.fromEntries(keys.map((k) => [k, sk(p[k])])) });
    }
    stack.push(f.sibling, f.child);
  }
  const rich = workers && [...workers].sort((a, b) => JSON.stringify(b.worker.availability || {}).length - JSON.stringify(a.worker.availability || {}).length)[0];
  const jobs = {}; for (const w of workers || []) { const j = w.worker?.job || "?"; jobs[j] = (jobs[j] || 0) + 1; }
  return { workers: workers?.length, avail: sk(rich?.worker?.availability), exc: sk(rich?.worker?.availabilityExceptions), jobsSample: sk(rich?.worker?.jobs), jobs, hits, svgCount: document.querySelectorAll("svg").length, canvas: document.querySelectorAll("canvas").length };
});
writeFileSync(process.argv[2], JSON.stringify(res, null, 1));
console.log("workers", res.workers, "hits", res.hits.length, "svg", res.svgCount, "canvas", res.canvas);
browser.disconnect();
