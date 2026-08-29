// modules/aurorbuddy/lib/tests/search_time_range.test.mjs
//
// Pins how searchPeople expresses the analyst's 30/60/90-day choice on the
// wire. `timeRangeFilter` is a CLOSED ENUM on Auror's side and neither
// "Last60days" nor "Last90days" is in it — sending either is an
// unconditional HTTP 400, which is exactly what shipped in the suite: the
// 60- and 90-day buttons in view.html could never return a result.
//
// Longer-than-30 ranges must therefore go through Auror's Custom range,
// whose accepted shape is narrow and was arrived at by elimination
// (shanesmith v0.1.63 → v0.1.70). What every assertion below is defending:
//   · a preset range still sends the preset and no dates
//   · >30 days sends bare YYYY-MM-DD dates and OMITS timeRangeFilter
//     entirely — "Custom" as a value 400s, and so do full ISO timestamps
//   · every page of a paginated scan carries the same range, so page 2
//     cannot silently widen the window page 1 established
//
// Enum reference: shanesmith/docs/AUROR_API_MAP.md §"timeRangeFilter enum".

import test from "node:test";
import assert from "node:assert/strict";

import { searchPeople } from "../auror.js";

const STORES = [
  { number: "1458", auror_site: "SITE: WALMART 1458 - 1 MAIN ST, ANYTOWN, TN" },
  { number: "669",  auror_site: "SITE: WALMART 669 - 2 OAK AVE, ANYTOWN, TN" },
];

// Runs a scan against a stubbed fetch and returns the URLSearchParams of
// every request it made, in order.
async function paramsFor(days, { totalResultCount = 0 } = {}) {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(new URL(url).searchParams);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ totalResultCount, searchResults: [] }),
    };
  };
  try {
    await searchPeople({ token: "jwt", stores: STORES, homeStore: "1458", days });
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

test("a valid preset is sent as the preset, with empty dates", async () => {
  const [p] = await paramsFor("Last30days");
  assert.equal(p.get("timeRangeFilter"), "Last30days");
  assert.equal(p.get("startDate"), "");
  assert.equal(p.get("endDate"), "");
});

test("Last60days becomes a custom date range, not a preset", async () => {
  const [p] = await paramsFor("Last60days");
  // The whole point: this value must never reach Auror.
  assert.equal(p.has("timeRangeFilter"), false);
  assert.match(p.get("startDate"), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(p.get("endDate"), /^\d{4}-\d{2}-\d{2}$/);
});

test("Last90days likewise — the enum has no 90-day member at all", async () => {
  const [p] = await paramsFor("Last90days");
  assert.equal(p.has("timeRangeFilter"), false);
  assert.match(p.get("startDate"), /^\d{4}-\d{2}-\d{2}$/);
});

test("custom dates are bare YYYY-MM-DD, never full ISO timestamps", async () => {
  const [p] = await paramsFor("Last60days");
  // v0.1.65 sent "2026-06-30T00:00:00.000Z" here and Auror 400'd it.
  assert.doesNotMatch(p.get("startDate"), /T|Z/);
  assert.doesNotMatch(p.get("endDate"), /T|Z/);
});

test("the custom window spans the requested number of days", async () => {
  const [p] = await paramsFor("Last60days");
  const start = new Date(p.get("startDate") + "T00:00:00Z");
  const end   = new Date(p.get("endDate")   + "T00:00:00Z");
  const spanDays = Math.round((end - start) / 86_400_000);
  // Date-only truncation of a 60×24h subtraction lands on 60 or 61
  // depending on where "now" sits relative to UTC midnight.
  assert.ok(spanDays === 60 || spanDays === 61, `span was ${spanDays}`);
});

test("an unspecified range falls back to the 30-day preset", async () => {
  const [p] = await paramsFor(undefined);
  assert.equal(p.get("timeRangeFilter"), "Last30days");
});

test("every page of a paginated scan carries the same range", async () => {
  // 45 results at PAGE_SIZE 20 ⇒ page 0 plus two more pages.
  const pages = await paramsFor("Last60days", { totalResultCount: 45 });
  assert.ok(pages.length > 1, `expected pagination, got ${pages.length} page(s)`);
  const [first] = pages;
  for (const p of pages) {
    assert.equal(p.has("timeRangeFilter"), false);
    assert.equal(p.get("startDate"), first.get("startDate"));
    assert.equal(p.get("endDate"),   first.get("endDate"));
  }
  assert.deepEqual(pages.map(p => p.get("skip")), ["0", "20", "40"]);
});

test("the home store is excluded from siteTraits", async () => {
  const [p] = await paramsFor("Last30days");
  const traits = p.getAll("siteTraits");
  assert.equal(traits.length, 1);
  assert.match(traits[0], /WALMART 669/);
});
