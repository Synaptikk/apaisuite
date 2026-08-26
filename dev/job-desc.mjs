// dev/job-desc.mjs
//
// Does the React data carry a human job TITLE, or only the code?
//
// dev/job-titles.mjs could only recover 11 titles because the roster list is
// virtualised — page text holds the rendered rows and nothing else. Any worker
// whose row was never painted falls back to the bare job code
// ("1-936-1451"), which cannot match a /digital/ rule, so they classify as
// Store Help regardless of what they actually do.
//
// worker.jobs[] has a `jobDescription` field. If that is the title, the whole
// DOM-scraping approach is unnecessary.
//
//   node dev/job-desc.mjs
//
// PRIVACY: prints job codes and titles only — roles, not people.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null })
  .catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });

const page = await browser.newPage();
await page.goto("https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler",
  { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || "").length > 5000,
  { timeout: 90_000, polling: 1000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 8000));

const out = await page.evaluate(() => {
  let W = null, visited = 0;
  const walk = (f) => {
    if (!f || W || visited > 60000) return;
    visited++;
    const p = f.memoizedProps;
    if (p && typeof p === "object" && Array.isArray(p.workers) && p.workers.length > 3) { W = p.workers; return; }
    walk(f.child); walk(f.sibling);
  };
  for (const el of document.querySelectorAll("*")) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (k) { walk(el[k]); break; }
  }
  if (!W) return { error: "no workers" };

  const byCode = new Map();
  let shiftJobKeys = null;
  for (const w of W) {
    for (const j of w?.worker?.jobs || []) {
      if (!byCode.has(j.jobName)) {
        byCode.set(j.jobName, { code: j.jobName, description: j.jobDescription ?? null, jobId: j.jobId ?? null });
      }
    }
    for (const d of w?.weekEvents?.[0] || []) {
      if (d?.shift && !shiftJobKeys) shiftJobKeys = Object.keys(d.shift).filter((k) => /job/i.test(k))
        .map((k) => `${k}=${JSON.stringify(d.shift[k])}`);
    }
  }
  return { workers: W.length, codes: [...byCode.values()], shiftJobKeys };
});

if (out.error) { console.error("✗ " + out.error); process.exit(1); }

console.log(`workers: ${out.workers}, distinct job codes: ${out.codes.length}`);
console.log(`shift job fields: ${JSON.stringify(out.shiftJobKeys)}\n`);

const withDesc = out.codes.filter((c) => c.description);
console.log(`codes carrying a jobDescription: ${withDesc.length}/${out.codes.length}\n`);

out.codes.sort((a, b) => String(a.description || a.code).localeCompare(String(b.description || b.code)));
for (const c of out.codes) {
  const d = /\bdigital\b/i.test(c.description || "") ? "D" : " ";
  console.log(`${d}  ${String(c.description ?? "(none)").padEnd(46)} ${c.code}`);
}

await page.close();
browser.disconnect();
