// dev/probe-workvivo-users.mjs
// Workvivo has its own internal people directory keyed by username/email.
// If we can hit it from the user's existing workvivo session, that's the
// simplest username→name resolver for our use case.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();

// Start on workvivo so we have the right origin/cookies.
console.log("→ workvivo home…");
try {
  await page.goto("https://workvivo.walmart.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
} catch (e) {
  console.log(`  goto soft-fail: ${e.message}`);
}
console.log(`  url: ${page.url()}`);

if (!/workvivo\.walmart\.com/.test(page.url())) {
  console.log("✗ Not on workvivo — likely SSO needed first. Open workvivo manually in this Edge, then re-run.");
  browser.disconnect();
  process.exit(0);
}

await new Promise((r) => setTimeout(r, 2000));

// Probe a few candidate workvivo people-search endpoints
const probes = [
  "/api/v2/users/search?query=ses008s",
  "/api/v2/users/search?q=ses008s",
  "/api/v2/users?search=ses008s",
  "/api/v2/users/ses008s",
  "/api/v1/users/search?query=ses008s",
  "/api/v1/users/ses008s",
  "/api/users/search?query=ses008s",
  "/api/people?search=ses008s",
  "/v2/users/lookup?username=ses008s",
];

for (const path of probes) {
  try {
    const out = await page.evaluate(async (p) => {
      const r = await fetch(p, { credentials: "include", headers: { Accept: "application/json" } });
      const text = await r.text();
      return { status: r.status, ct: r.headers.get("content-type"), text: text.slice(0, 600) };
    }, path);
    const interesting = out.status === 200 && /json/i.test(out.ct || "");
    console.log(`${interesting ? "★" : " "} ${out.status}  ${path}`);
    if (interesting || (out.status >= 200 && out.status < 400)) {
      console.log(`    ct=${out.ct}`);
      console.log(`    body: ${out.text.replace(/\n/g, " ").slice(0, 500)}`);
    }
  } catch (e) {
    console.log(`✗ ${path}  err=${e.message}`);
  }
}

browser.disconnect();
process.exit(0);
