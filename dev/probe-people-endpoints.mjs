// dev/probe-people-endpoints.mjs
//
// Try several plausible "find a person by username" endpoints on
// one.walmart.com using the user's existing session. Reports which ones
// return data and what the response shape looks like.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();

// Land on one.walmart.com first so the page has the right cookies/origin.
await page.goto("https://one.walmart.com/", { waitUntil: "domcontentloaded", timeout: 20000 });

const USERNAME  = process.argv[2] || "ses008s";
const variants = [
  // workvivoprofile with different email formats
  `https://one.walmart.com/content/api/adp/workvivoprofile.json?email=${USERNAME}@walmart.com`,
  `https://one.walmart.com/content/api/adp/workvivoprofile.json?email=${USERNAME}@wal-mart.com`,
  `https://one.walmart.com/content/api/adp/workvivoprofile.json?email=${USERNAME}.us@wal-mart.com`,
  // adp profile API — guess at common shapes
  `https://one.walmart.com/content/api/adp/profile.json?username=${USERNAME}`,
  `https://one.walmart.com/content/api/adp/user.json?username=${USERNAME}`,
  `https://one.walmart.com/content/api/adp/userprofile.json?username=${USERNAME}`,
  `https://one.walmart.com/content/api/adp/userprofile.json?email=${USERNAME}@walmart.com`,
  // search with people-specific search_type
  // (these will be POSTed below, separate handling)
];

// GET probes
for (const url of variants) {
  try {
    const out = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include" });
      const text = await r.text();
      return { status: r.status, ct: r.headers.get("content-type"), text: text.slice(0, 400) };
    }, url);
    const interesting = out.status !== 404 && out.status !== 403 && !/<!DOCTYPE/i.test(out.text);
    console.log(`${interesting ? "★" : " "} ${out.status}  ${url}`);
    console.log(`    ct=${out.ct}`);
    if (interesting) console.log(`    body: ${out.text}`);
    else console.log(`    body: ${out.text.slice(0,80).replace(/\n/g," ")}…`);
  } catch (e) {
    console.log(`✗ ${url}\n    error: ${e.message}`);
  }
}

// People-flavored aisearch attempts
console.log("\n── aisearch.json POST variants ──");
const searchVariants = [
  { search_type: "people",   query: USERNAME },
  { search_type: "users",    query: USERNAME },
  { search_type: "person",   query: USERNAME },
  { search_type: "directory", query: USERNAME },
  { search_type: "workvivo", query: USERNAME },
];
for (const body of searchVariants) {
  try {
    const out = await page.evaluate(async (b) => {
      const r = await fetch("https://one.walmart.com/content/api/adp/internal/aisearch.json", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language_code: "en_us",
          count: 5,
          offset: 0,
          user_filter: "",
          ...b,
        }),
      });
      const text = await r.text();
      return { status: r.status, text: text.slice(0, 800) };
    }, body);
    console.log(`  ${out.status}  search_type=${body.search_type}`);
    console.log(`    ${out.text.slice(0, 600)}`);
  } catch (e) {
    console.log(`  ✗ search_type=${body.search_type}: ${e.message}`);
  }
}

browser.disconnect();
process.exit(0);
