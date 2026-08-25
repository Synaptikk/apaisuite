// modules/digitalmetrics/lib/tests/insights.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/insights.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dailyPicks, digitalTone, distribution,
  scanHour, storeHelpPeakHours, formatHour, lateStarts,
} from "../data/insights.js";
import * as insightsPage from "../pages/insights.js";

const row = (over = {}) => ({
  Associate: "A", "Pick Date": "12/01/25",
  "Picked As Req Qty": 100, "Exception Picked As Req Qty": 0, ...over,
});

test("daily picks split Digital, Exceptions and Store Help", () => {
  const [day] = dailyPicks(
    [row({ Associate: "D" }), row({ Associate: "E" }), row({ Associate: "S" })],
    { D: "Digital", E: "Exceptions", S: "Store Help" },
  );
  assert.equal(day.total, 300);
  assert.equal(day.digitalTotal, 200, "Exceptions count as digital work");
  assert.equal(day.storeHelp, 100);
  assert.equal(day.digitalPct, 67);
});

test("days are listed most recent first", () => {
  const days = dailyPicks([
    row({ "Pick Date": "12/01/25" }),
    row({ "Pick Date": "12/03/25" }),
    row({ "Pick Date": "12/02/25" }),
  ], {});
  assert.deepEqual(days.map((d) => d.date), ["12/03/25", "12/02/25", "12/01/25"]);
});

test("blank dates inherit the previous day", () => {
  const days = dailyPicks([row(), row({ "Pick Date": undefined })], {});
  assert.equal(days.length, 1);
  assert.equal(days[0].total, 200);
});

test("digital share bands are green above 85, orange to 70, red below", () => {
  assert.equal(digitalTone(90), "good");
  assert.equal(digitalTone(85), "good");
  assert.equal(digitalTone(84), "warn");
  assert.equal(digitalTone(70), "warn");
  assert.equal(digitalTone(69), "bad");
});

test("distribution totals the whole period", () => {
  const d = distribution(dailyPicks(
    [row({ Associate: "D" }), row({ Associate: "S" })], { D: "Digital", S: "Store Help" }));
  assert.equal(d.total, 200);
  assert.equal(d.digitalPct, 50);
  assert.equal(d.storeHelpPct, 50);
});

test("distribution of nothing is zero, not NaN", () => {
  const d = distribution([]);
  assert.equal(d.total, 0);
  assert.equal(d.digitalPct, 0);
});

// ── hours ────────────────────────────────────────────────────────────────
test("scan times parse to a 24-hour clock", () => {
  assert.equal(scanHour("12/6/25 9:08 AM"), 9);
  assert.equal(scanHour("12/6/25 1:30 PM"), 13);
  assert.equal(scanHour("12:15 AM"), 0, "midnight is hour 0");
  assert.equal(scanHour("12:15 PM"), 12, "noon is hour 12");
  assert.equal(scanHour("nonsense"), null);
  assert.equal(scanHour(undefined), null);
});

test("peak hours cover only Store Help, busiest first", () => {
  const peaks = storeHelpPeakHours([
    row({ Associate: "S", "Min. First Scan": "12/1/25 10:00 AM", "Picked As Req Qty": 50 }),
    row({ Associate: "S", "Min. First Scan": "12/1/25 2:00 PM",  "Picked As Req Qty": 150 }),
    row({ Associate: "D", "Min. First Scan": "12/1/25 5:00 AM",  "Picked As Req Qty": 999 }),
  ], { S: "Store Help", D: "Digital" });

  assert.equal(peaks.length, 2, "the Digital row must not appear");
  assert.equal(peaks[0].hour, 14);
  assert.equal(peaks[0].pct, 75);
});

test("hours format for humans", () => {
  assert.equal(formatHour(0), "12 AM");
  assert.equal(formatHour(9), "9 AM");
  assert.equal(formatHour(12), "12 PM");
  assert.equal(formatHour(17), "5 PM");
});

// ── late starts ──────────────────────────────────────────────────────────
test("only 5:00-5:50 AM scans count as 5am starts", () => {
  const out = lateStarts([
    row({ Associate: "A", "Min. First Scan": "12/1/25 5:10 AM" }),
    row({ Associate: "B", "Min. First Scan": "12/1/25 5:51 AM" }),  // early 6am
    row({ Associate: "C", "Min. First Scan": "12/1/25 5:30 PM" }),  // evening
  ], [], {});
  assert.deepEqual(out.people.map((p) => p.name), ["A"]);
});

test("Store Help and Fashion are excluded from late starts", () => {
  // The donor's tab description says both are excluded; its code excluded only
  // Store Help. This asserts the documented behaviour.
  const out = lateStarts([
    row({ Associate: "SH", "Min. First Scan": "12/1/25 5:30 AM" }),
    row({ Associate: "FA", "Min. First Scan": "12/1/25 5:30 AM" }),
    row({ Associate: "DG", "Min. First Scan": "12/1/25 5:30 AM" }),
  ], [], { SH: "Store Help", FA: "Fashion", DG: "Digital" });
  assert.deepEqual(out.people.map((p) => p.name), ["DG"]);
});

test("lost picks are estimated from the associate's own pick rate", () => {
  const out = lateStarts(
    [row({ Associate: "A", "Min. First Scan": "12/1/25 5:30 AM" })],
    [{ name: "A", pick_rate: 100 }], {},
  );
  assert.equal(out.people[0].totalLost, 30);
  assert.equal(out.people[0].lostPicks, 50, "half an hour at 100/hr");
  assert.equal(out.totalLostPicks, 50);
});

test("only days over 5 minutes late are flagged, but all count toward time lost", () => {
  const out = lateStarts([
    row({ Associate: "A", "Pick Date": "12/01/25", "Min. First Scan": "12/1/25 5:02 AM" }),
    row({ Associate: "A", "Pick Date": "12/02/25", "Min. First Scan": "12/2/25 5:20 AM" }),
  ], [], {});
  assert.equal(out.people[0].dayCount, 2);
  assert.equal(out.people[0].lateDays.length, 1);
  assert.equal(out.people[0].totalLost, 22);
});

test("average start is weighted by days worked", () => {
  const out = lateStarts([
    row({ Associate: "A", "Pick Date": "12/01/25", "Min. First Scan": "12/1/25 5:10 AM" }),
    row({ Associate: "A", "Pick Date": "12/02/25", "Min. First Scan": "12/2/25 5:10 AM" }),
    row({ Associate: "B", "Pick Date": "12/01/25", "Min. First Scan": "12/1/25 5:40 AM" }),
  ], [], {});
  assert.equal(out.avgStartMinutes, 20, "(10+10+40)/3, not (10+40)/2");
});

test("no 5am associates yields zeroes, not NaN", () => {
  const out = lateStarts([], [], {});
  assert.equal(out.associateCount, 0);
  assert.equal(out.avgStartMinutes, 0);
});

// ── page ─────────────────────────────────────────────────────────────────
test("insights page renders, and handles empty state", () => {
  const ctx = {
    rawData: [row({ Associate: "D", "Min. First Scan": "12/1/25 5:20 AM" })],
    associates: [{ name: "D", pick_rate: 100 }],
    classifications: { D: "Digital" },
  };
  const html = insightsPage.render(ctx);
  assert.match(html, /Daily Picks/);
  assert.match(html, /5am Late Starts/);
  assert.doesNotThrow(() => insightsPage.render({ rawData: [] }));
});

test("insights escapes associate names", () => {
  const html = insightsPage.render({
    rawData: [row({ Associate: "<img src=x>", "Min. First Scan": "12/1/25 5:20 AM" })],
    associates: [], classifications: {},
  });
  assert.ok(!html.includes("<img src=x"));
});
