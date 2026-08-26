// dev/job-titles.mjs
//
// List the distinct job titles the scheduler shows, so classification rules
// can be written against what is really there rather than guessed.
//
//   node dev/job-titles.mjs
//
// PRIVACY: job titles are roles, not people. No names are read or printed.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null })
  .catch((e) => { console.error(`✗ attach failed: ${e.message}\n  Run ./dev/launch-edge-debug.sh`); process.exit(1); });

const page = await browser.newPage();
await page.goto("https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler",
  { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForFunction(() => (document.body?.innerText || "").length > 5000,
  { timeout: 90_000, polling: 1000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 8000));

const out = await page.evaluate(() => {
  const text = document.body?.innerText || "";
  // Same extraction lib/sources/wfm_schedule.js uses: a title followed by its
  // job code on one line.
  const titles = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?)\s+(\d{1,2}-\d{2,3}-\d{3,4})\b/);
    if (!m) continue;
    const title = m[1].trim();
    if (title.length < 3 || !/[A-Za-z]{3}/.test(title)) continue;
    titles.set(m[2], title);
  }
  return [...titles.entries()].map(([code, title]) => ({ code, title }));
});

out.sort((a, b) => a.title.localeCompare(b.title));
console.log(`${out.length} distinct job titles\n`);
for (const { code, title } of out) {
  const digital = /\bdigital\b/i.test(title);
  const lead = /\b(TL|TEAM ?LEAD|COACH|LEAD)\b/i.test(title);
  console.log(`${digital ? "D" : " "}${lead ? "L" : " "}  ${title.padEnd(42)} ${code}`);
}
console.log("\nD = matches the current /\\bdigital\\b/i rule, L = looks like a lead role");

await page.close();
browser.disconnect();
