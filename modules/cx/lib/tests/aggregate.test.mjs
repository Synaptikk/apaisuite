// modules/cx/lib/tests/aggregate.test.mjs
//
// Pins the analytic decisions that are easy to break and impossible to notice
// from the UI — the ones where a wrong answer still draws a plausible chart.
//
//   node modules/cx/lib/tests/aggregate.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  filterRecords, ratingMix, weeklyRatingMix, themeBreakdown, movement,
  addDays, isoWeekStart, journeyFacets,
} from "../aggregate.js";
import { themeFor, polarityOf, ratingBand, splitTopic } from "../topics.js";
import { normalizeRecord } from "../medallia.js";

// ── Fixtures ────────────────────────────────────────────────────────────

let seq = 0;
const rec = ({ day, score = 5, journey = "Store", channel = "Surveys", text = "x", topics = [] }) => ({
  id: `r${++seq}`,
  ts: `${day} 12:00:00`,
  day,
  journey,
  channel,
  score,
  field: "Comment",
  text,
  topics,
  sentiment: null,
});

const t = (name, sentiment) => ({ name, sentiment });

// ── topics.js ───────────────────────────────────────────────────────────

test("parallel Medallia taxonomies fold into one theme", () => {
  // The whole reason topics.js exists: these are the same problem under two
  // names, and ranked separately neither reaches the top of the list.
  assert.equal(themeFor("Interaction - Attitude"), "associates");
  assert.equal(themeFor("Associate Interaction - Attitude"), "associates");
  assert.equal(themeFor("Associate -Direct Mentions"), "associates");
  assert.equal(themeFor("Associate Dept - Checkout"), "associates");

  assert.equal(themeFor("Checkout - Self Checkout"), "checkout");
  assert.equal(themeFor("Checkout Experience - Checkout Process"), "checkout");

  assert.equal(themeFor("Product Availability - Availability/Out of Stock"), "availability");
  assert.equal(themeFor("Product Page - Stock/Availability Information"), "availability");
});

test("an unmapped family becomes its own theme rather than disappearing", () => {
  // A Medallia taxonomy change must show up in the UI, not silently shrink the
  // totals.
  assert.equal(themeFor("Brand New Family - Something"), "other:Brand New Family");
});

test("subtheme overrides beat the family map", () => {
  assert.equal(themeFor("Payment/Fees - Payment Methods"), "checkout");
  assert.equal(themeFor("Payment/Fees - Delivery Fees"), "price");
  // ...and an unlisted subtheme of the same family still follows the family.
  assert.equal(themeFor("Payment/Fees - Something Else"), "digital");
});

test("splitTopic keeps further dashes inside the subtheme", () => {
  assert.deepEqual(splitTopic("Delivery Location - Drop Off Error - Pic"),
                   { family: "Delivery Location", subtheme: "Drop Off Error - Pic" });
  assert.deepEqual(splitTopic("Associate -Direct Mentions"),
                   { family: "Associate -Direct Mentions", subtheme: null });
});

test("MIXED_OPINION counts as negative", () => {
  // "the cashier was lovely but the wait was 20 minutes" — the actionable half
  // is the wait, and filing it neutral hides it entirely.
  assert.equal(polarityOf("MIXED_OPINION"), "negative");
  assert.equal(polarityOf("STRONGLY_NEGATIVE"), "negative");
  assert.equal(polarityOf("POSITIVE"), "positive");
  assert.equal(polarityOf("NO_OPINION"), "neutral");
  assert.equal(polarityOf(undefined), "neutral");
});

test("rating bands follow NPS convention on the 5-point survey", () => {
  assert.equal(ratingBand(5), "promoter");
  assert.equal(ratingBand(4), "passive");
  assert.equal(ratingBand(3), "detractor");
  assert.equal(ratingBand(1), "detractor");
  assert.equal(ratingBand(null), null);
});

// ── normalizeRecord ─────────────────────────────────────────────────────

test("topic sentiment is resolved by span overlap, not by position", () => {
  const node = {
    id: "n1",
    timestamp: "2026-09-24 16:53:18",
    journey: ["Scheduled Delivery"],
    subject: ["1458 - FORT OGLETHORPE - GA | Surveys"],
    scoreFieldData: [{ field: { id: "s" }, values: ["3"] }],
    commentData: [{
      field: { id: "q_x", name: "Customer Comments" },
      textsWithLanguage: [{ text: "Driver was lovely. The milk was bloated and oozing." }],
      matchingTaggings: {
        // Positive span covers the driver, negative span covers the milk.
        sentimentRegions: [
          { startIndex: 0,  endIndex: 20, sentiment: "POSITIVE" },
          { startIndex: 21, endIndex: 51, sentiment: "NEGATIVE" },
        ],
        topicRegions: [
          { startIndex: 0,  endIndex: 6,  topics: [{ id: "1", name: "Fulfillment - Delivery Experience" }] },
          { startIndex: 25, endIndex: 30, topics: [{ id: "2", name: "Product - Product Quality/Condition" }] },
        ],
      },
      sentimentTaggings: [{ sentiment: "MIXED_OPINION", regions: [] }],
    }],
  };
  const r = normalizeRecord(node);
  assert.equal(r.day, "2026-09-24");
  assert.equal(r.journey, "Scheduled Delivery");
  assert.equal(r.channel, "Surveys");        // store half of `subject` dropped
  assert.equal(r.score, 3);

  const byName = Object.fromEntries(r.topics.map((x) => [x.name, x.sentiment]));
  assert.equal(byName["Fulfillment - Delivery Experience"], "POSITIVE");
  assert.equal(byName["Product - Product Quality/Condition"], "NEGATIVE");
});

test("with no overlapping span the whole-comment sentiment is used", () => {
  const r = normalizeRecord({
    id: "n2", timestamp: "2026-09-01 08:00:00", journey: ["Store"], subject: ["1458 - X | Surveys"],
    scoreFieldData: [{ values: ["1"] }],
    commentData: [{
      field: { id: "q", name: "Comment" },
      textsWithLanguage: [{ text: "Checkout was horrific!" }],
      matchingTaggings: { sentimentRegions: [], topicRegions: [{ startIndex: 0, endIndex: 8, topics: [{ name: "Checkout - General" }] }] },
      sentimentTaggings: [{ sentiment: "STRONGLY_NEGATIVE", regions: [] }],
    }],
  });
  assert.equal(r.topics[0].sentiment, "STRONGLY_NEGATIVE");
});

test("one topic tagged on several spans is counted once, worst reading kept", () => {
  // Otherwise a long rambling comment weighs like several separate complaints.
  const r = normalizeRecord({
    id: "n3", timestamp: "2026-09-01 08:00:00", journey: ["Store"], subject: ["1458 - X | Surveys"],
    scoreFieldData: [{ values: ["2"] }],
    commentData: [{
      field: { id: "q", name: "Comment" },
      textsWithLanguage: [{ text: "a".repeat(60) }],
      matchingTaggings: {
        sentimentRegions: [
          { startIndex: 0,  endIndex: 10, sentiment: "POSITIVE" },
          { startIndex: 20, endIndex: 30, sentiment: "NEGATIVE" },
          { startIndex: 40, endIndex: 50, sentiment: "NO_OPINION" },
        ],
        topicRegions: [
          { startIndex: 1,  endIndex: 5,  topics: [{ name: "Checkout - Lines/Wait Time" }] },
          { startIndex: 21, endIndex: 25, topics: [{ name: "Checkout - Lines/Wait Time" }] },
          { startIndex: 41, endIndex: 45, topics: [{ name: "Checkout - Lines/Wait Time" }] },
        ],
      },
      sentimentTaggings: [],
    }],
  });
  assert.equal(r.topics.length, 1);
  assert.equal(r.topics[0].sentiment, "NEGATIVE");
});

test("the longest populated comment field wins", () => {
  const r = normalizeRecord({
    id: "n4", timestamp: "2026-09-01 08:00:00", journey: ["Store"], subject: ["1458 - X | Surveys"],
    scoreFieldData: [{ values: ["5"] }],
    commentData: [
      { field: { id: "a", name: "Short" }, textsWithLanguage: [{ text: "ok" }], sentimentTaggings: [] },
      { field: { id: "b", name: "Real" },  textsWithLanguage: [{ text: "the actual verbatim goes here" }], sentimentTaggings: [] },
    ],
  });
  assert.equal(r.field, "Real");
  assert.equal(r.text, "the actual verbatim goes here");
});

// ── filterRecords ───────────────────────────────────────────────────────

test("an empty chip selection means everything, never nothing", () => {
  const rows = [rec({ day: "2026-09-01", journey: "Store" }), rec({ day: "2026-09-02", journey: "Shipping" })];
  assert.equal(filterRecords(rows, { journeys: [] }).length, 2);
  assert.equal(filterRecords(rows, { journeys: null }).length, 2);
  assert.equal(filterRecords(rows, {}).length, 2);
  assert.equal(filterRecords(rows, { journeys: ["Store"] }).length, 1);
});

test("date bounds are inclusive at both ends", () => {
  const rows = ["2026-08-31", "2026-09-01", "2026-09-15", "2026-09-16"].map((day) => rec({ day }));
  assert.equal(filterRecords(rows, { from: "2026-09-01", to: "2026-09-15" }).length, 2);
});

test("journey facets are ordered by volume", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => rec({ day: "2026-09-01", journey: "Store" })),
    ...Array.from({ length: 7 }, () => rec({ day: "2026-09-01", journey: "Scheduled Delivery" })),
  ];
  assert.deepEqual(journeyFacets(rows).map((f) => f.value), ["Scheduled Delivery", "Store"]);
});

// ── ratingMix ───────────────────────────────────────────────────────────

test("comment NPS is promoters minus detractors over rated comments only", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => rec({ day: "2026-09-01", score: 5 })),
    ...Array.from({ length: 1 }, () => rec({ day: "2026-09-01", score: 4 })),
    ...Array.from({ length: 3 }, () => rec({ day: "2026-09-01", score: 1 })),
    rec({ day: "2026-09-01", score: null }),   // unrated: out of the denominator
  ];
  const mix = ratingMix(rows);
  assert.equal(mix.total, 11);
  assert.equal(mix.scored, 10);
  assert.deepEqual(mix.bands, { promoter: 6, passive: 1, detractor: 3 });
  assert.equal(mix.commentNps, 30);
});

test("ratingMix on nothing returns nulls, not NaN", () => {
  const mix = ratingMix([]);
  assert.equal(mix.commentNps, null);
  assert.equal(mix.mean, null);
  assert.equal(mix.scored, 0);
});

test("weekly mix buckets by Monday and comes back oldest first", () => {
  // 2026-09-24 is a Thursday; its week starts Monday 2026-09-21.
  const rows = [rec({ day: "2026-09-24" }), rec({ day: "2026-09-21" }), rec({ day: "2026-09-14" })];
  const weeks = weeklyRatingMix(rows);
  assert.deepEqual(weeks.map((w) => w.weekStart), ["2026-09-14", "2026-09-21"]);
  assert.equal(weeks[1].scored, 2);
});

// ── themeBreakdown ──────────────────────────────────────────────────────

test("a comment hitting one theme twice counts once for that theme", () => {
  const rows = [rec({
    day: "2026-09-01", score: 1,
    topics: [t("Interaction - Attitude", "NEGATIVE"), t("Associate Interaction - Helpfulness", "NEGATIVE")],
  })];
  const b = themeBreakdown(rows);
  const assoc = b.all.find((x) => x.themeId === "associates");
  assert.equal(assoc.mentions, 1, "one comment is one mention of the theme");
  assert.equal(assoc.negative, 1);
  // ...while the per-topic detail still shows both.
  assert.equal(assoc.topics.length, 2);
});

test("within one comment the negative reading of a theme wins the count", () => {
  const rows = [rec({
    day: "2026-09-01",
    topics: [t("Checkout - General", "POSITIVE"), t("Checkout - Self Checkout", "NEGATIVE")],
  })];
  const b = themeBreakdown(rows);
  const checkout = b.byTheme.get("checkout");
  assert.equal(checkout.negative, 1);
  assert.equal(checkout.positive, 0);
});

test("negativeShare excludes neutral mentions from its denominator", () => {
  const rows = [
    rec({ day: "2026-09-01", topics: [t("Checkout - General", "NEGATIVE")] }),
    rec({ day: "2026-09-01", topics: [t("Checkout - General", "POSITIVE")] }),
    rec({ day: "2026-09-01", topics: [t("Checkout - General", "NO_OPINION")] }),
  ];
  const checkout = themeBreakdown(rows).byTheme.get("checkout");
  assert.equal(checkout.mentions, 3);
  assert.equal(checkout.neutral, 1);
  // 1 negative of 2 opinions, not of 3 mentions.
  assert.equal(checkout.negativeShare, 0.5);
});

test("taggedCount reports the tagged minority, not the whole set", () => {
  const rows = [
    rec({ day: "2026-09-01", topics: [t("Checkout - General", "NEGATIVE")] }),
    rec({ day: "2026-09-01", topics: [] }),
    rec({ day: "2026-09-01", topics: [] }),
  ];
  const b = themeBreakdown(rows);
  assert.equal(b.taggedCount, 1);
  assert.equal(b.totalRecords, 3);
});

test("a strongly-negative theme outranks a merely busier mixed one", () => {
  const rows = [
    ...Array.from({ length: 2 }, () => rec({ day: "2026-09-01", topics: [t("Checkout - General", "STRONGLY_NEGATIVE")] })),
    ...Array.from({ length: 3 }, () => rec({ day: "2026-09-01", topics: [t("Pricing Value - Value for Money", "MIXED_OPINION")] })),
  ];
  const b = themeBreakdown(rows);
  // checkout: 2 x 1.5 = 3.0   price: 3 x 0.5 = 1.5
  assert.equal(b.negative[0].themeId, "checkout");
});

test("a theme both praised and criticised appears in both columns", () => {
  const rows = [
    rec({ day: "2026-09-01", topics: [t("Checkout - Lines/Wait Time", "NEGATIVE")] }),
    rec({ day: "2026-09-01", topics: [t("Checkout - General", "POSITIVE")] }),
  ];
  const b = themeBreakdown(rows);
  assert.ok(b.negative.some((x) => x.themeId === "checkout"));
  assert.ok(b.positive.some((x) => x.themeId === "checkout"));
});

test("examples are capped and carry the verbatim", () => {
  const rows = Array.from({ length: 12 }, (_, i) => rec({
    day: "2026-09-01", text: `complaint ${i}`, topics: [t("Checkout - General", "NEGATIVE")],
  }));
  const checkout = themeBreakdown(rows, { examplesPerTheme: 3 }).byTheme.get("checkout");
  assert.equal(checkout.examples.negative.length, 3);
  assert.equal(checkout.examples.negative[0].text, "complaint 0");
});

// ── movement ────────────────────────────────────────────────────────────

test("movement compares negative mentions per 100 comments, not raw counts", () => {
  // Prior window: 4 negatives in 100 comments = 4.0 per 100.
  // Recent window: 3 negatives in 50 comments = 6.0 per 100 — worse, despite
  // FEWER complaints. A raw count would call this an improvement.
  const rows = [];
  const priorDay = "2026-08-01", recentDay = "2026-09-01";
  for (let i = 0; i < 4; i++)  rows.push(rec({ day: priorDay, topics: [t("Checkout - General", "NEGATIVE")] }));
  for (let i = 0; i < 96; i++) rows.push(rec({ day: priorDay }));
  for (let i = 0; i < 3; i++)  rows.push(rec({ day: recentDay, topics: [t("Checkout - General", "NEGATIVE")] }));
  for (let i = 0; i < 47; i++) rows.push(rec({ day: recentDay }));

  const m = movement(rows, { windowDays: 28, asOf: "2026-09-25", minMentions: 1 });
  const checkout = m.movers.find((x) => x.themeId === "checkout");
  assert.equal(checkout.priorNegative, 4);
  assert.equal(checkout.recentNegative, 3);
  assert.equal(checkout.priorRate, 4);
  assert.equal(checkout.recentRate, 6);
  assert.equal(checkout.direction, "worse");
});

test("the two comparison windows are the same length and do not overlap", () => {
  const rows = [rec({ day: "2026-09-25" })];
  const m = movement(rows, { windowDays: 28, asOf: "2026-09-25" });
  assert.equal(m.recent.from, "2026-08-29");
  assert.equal(m.recent.to, "2026-09-25");
  assert.equal(m.prior.to, "2026-08-28");
  assert.equal(m.prior.from, "2026-08-01");
});

test("thin themes are listed but never ranked above real movers", () => {
  const rows = [];
  // A thin theme with a huge relative swing...
  rows.push(rec({ day: "2026-09-20", topics: [t("Tipping - General", "NEGATIVE")] }));
  // ...and a real one with a smaller swing but enough volume to mean something.
  for (let i = 0; i < 8; i++) rows.push(rec({ day: "2026-09-20", topics: [t("Checkout - General", "NEGATIVE")] }));
  for (let i = 0; i < 2; i++) rows.push(rec({ day: "2026-08-10", topics: [t("Checkout - General", "NEGATIVE")] }));
  for (let i = 0; i < 40; i++) rows.push(rec({ day: "2026-08-10" }));

  const m = movement(rows, { windowDays: 28, asOf: "2026-09-25", minMentions: 5 });
  assert.equal(m.movers[0].themeId, "checkout");
  const tipping = m.movers.find((x) => x.themeId === "handoff");
  assert.equal(tipping.thin, true, "Tipping folds into handoff and is too thin to rank");
});

test("movement on an empty set returns no movers instead of throwing", () => {
  const m = movement([]);
  assert.deepEqual(m.movers, []);
  assert.equal(m.recent, null);
});

// ── date helpers ────────────────────────────────────────────────────────

test("date maths is string-based and does not slip across month or UTC bounds", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-09-25", -364), "2025-09-26");
  // Monday stays put; Sunday walks back six days.
  assert.equal(isoWeekStart("2026-09-21"), "2026-09-21");
  assert.equal(isoWeekStart("2026-09-27"), "2026-09-21");
});

// ── Canonical topic merge (added after real data showed split rows) ──────

test("identical subthemes from the two taxonomies merge into one topic row", () => {
  // Against the real 90-day pull, "Attitude" arrived under both "Interaction"
  // and "Associate Interaction" and rendered as two rows labelled the same with
  // half the count each — the same top-of-list error the family map prevents,
  // one level down.
  const rows = [
    ...Array.from({ length: 5 }, () => rec({ day: "2026-09-01", topics: [t("Interaction - Attitude", "NEGATIVE")] })),
    ...Array.from({ length: 3 }, () => rec({ day: "2026-09-01", topics: [t("Associate Interaction - Attitude", "NEGATIVE")] })),
  ];
  const assoc = themeBreakdown(rows).byTheme.get("associates");
  const attitude = assoc.topics.filter((x) => x.label === "Attitude");
  assert.equal(attitude.length, 1, "one row, not two");
  assert.equal(attitude[0].mentions, 8);
  assert.deepEqual(attitude[0].sources.sort(),
    ["Associate Interaction - Attitude", "Interaction - Attitude"]);
});

test("Refunds merges across Service Desk and Returns", () => {
  const rows = [
    rec({ day: "2026-09-01", topics: [t("Service Desk - Refunds", "NEGATIVE")] }),
    rec({ day: "2026-09-01", topics: [t("Returns - Refunds", "NEGATIVE")] }),
  ];
  const desk = themeBreakdown(rows).byTheme.get("servicedesk");
  assert.equal(desk.topics.filter((x) => x.label === "Refunds").length, 1);
  assert.equal(desk.topics.find((x) => x.label === "Refunds").mentions, 2);
});

test("distinct subthemes in one theme stay distinct", () => {
  const rows = [
    rec({ day: "2026-09-01", topics: [t("Checkout - Self Checkout", "NEGATIVE")] }),
    rec({ day: "2026-09-01", topics: [t("Checkout - Lines/Wait Time", "NEGATIVE")] }),
  ];
  const checkout = themeBreakdown(rows).byTheme.get("checkout");
  assert.equal(checkout.topics.length, 2);
});

test("an ambiguous subtheme label is spelled out", () => {
  // Bare "Checkout" inside the Associates theme reads as the checkout THEME.
  const rows = [rec({ day: "2026-09-01", topics: [t("Associate Dept - Checkout", "POSITIVE")] })];
  const assoc = themeBreakdown(rows).byTheme.get("associates");
  assert.equal(assoc.topics[0].label, "At the checkout");
});

test("the long-tail families found in real data are all mapped", () => {
  // Each of these fell through to its own one-row theme before being mapped,
  // where a single mention ranked it as a mover.
  const seen = [
    "Account Activities - W+", "Pricing Accuracy - Accuracy", "Order Updates - WISMO",
    "Communication - Driver Chat/Call", "Payment - Payment Issues/Accuracy of Charges",
    "Fulfillment Options - 2 Hour Delivery", "Payment Methods - EBT",
    "Error/Speed - Malfunction/Error", "Post Transaction - Approve/Reject Substitution",
    "Restrooms - Cleanliness", "Cancellations - Cancelled by Customer",
    "Unique Items - Locked Items", "Competitive - Amazon",
    "Scan & Go General - General Satisfaction",
    "Scan & Go Scanning/Checkout/Payment - Scanning Experience",
  ];
  for (const name of seen) {
    assert.ok(!String(themeFor(name)).startsWith("other:"), `${name} is unmapped`);
  }
});
