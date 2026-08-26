// modules/digitalmetrics/lib/tests/clock.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseClock, scanHour, minutesPastFive } from "../data/clock.js";
import { formatHour } from "../data/insights.js";

// ── The regression this file exists for ───────────────────────────────────

test("a timestamp WITH SECONDS reads the hour, not the minutes", () => {
  // Tableau's MIN(First Scan) includes seconds. The old regex
  // /(\d+):(\d+)\s*(AM|PM)/ could not bridge the ":37 " before the meridiem,
  // so it backtracked onto "08:37 PM" and reported hour 8.
  assert.equal(scanHour("8/22/2026 1:08:37 PM"), 13);
  assert.equal(scanHour("8/22/2026 5:09:21 AM"), 5);
  assert.equal(scanHour("8/22/2026 9:21:04 PM"), 21);
});

test("the reported peak hours are impossible under the fix", () => {
  // Observed 2026-08-26: "21 PM", "18 PM", "11 PM", "7 PM", "1 AM".
  // "21 PM" is formatHour(33) — minute :21 plus 12 for PM. No input may
  // produce an hour outside 0–23 any more, so no such label can exist.
  for (const s of ["8/22/2026 1:21:37 PM", "8/22/2026 6:18:02 PM",
                   "8/22/2026 3:11:59 PM", "8/22/2026 4:07:10 PM"]) {
    const h = scanHour(s);
    assert.ok(h !== null && h >= 0 && h <= 23, `${s} -> ${h}`);
    assert.doesNotMatch(formatHour(h), /^(1[3-9]|2\d|3\d) /, `${s} -> ${formatHour(h)}`);
  }
});

test("every hour 0-23 formats inside a 12-hour clock", () => {
  for (let h = 0; h <= 23; h++) {
    assert.match(formatHour(h), /^(1[0-2]|[1-9]) (AM|PM)$/, `hour ${h} -> ${formatHour(h)}`);
  }
});

// ── formats actually seen in the data ─────────────────────────────────────

test("seconds are optional", () => {
  assert.equal(scanHour("12/6/25 9:08 AM"), 9);
  assert.equal(scanHour("9:08 AM"), 9);
});

test("meridiem is optional and then the value is 24-hour", () => {
  // The scheduler's ISO timestamps have no AM/PM.
  assert.equal(scanHour("2026-08-22T21:00:00"), 21);
  assert.equal(scanHour("17:30"), 17);
});

test("noon and midnight", () => {
  assert.equal(scanHour("12:00 PM"), 12);
  assert.equal(scanHour("12:00 AM"), 0);
  assert.equal(scanHour("12:45:10 AM"), 0);
});

test("parseClock returns minutes as well as the hour", () => {
  assert.deepEqual(parseClock("8/22/2026 1:08:37 PM"),
    { hour: 13, minutes: 8, hadMeridiem: true });
});

test("junk yields null rather than a wrong hour", () => {
  for (const v of [null, undefined, 42, "", "Available", "Not Scheduled"]) {
    assert.equal(scanHour(v), null, String(v));
  }
});

test("an impossible hour is rejected, not clamped", () => {
  // "25:00" must not silently become a valid bucket.
  assert.equal(scanHour("25:00"), null);
});

// ── minutesPastFive ───────────────────────────────────────────────────────

test("a 5am start with seconds is measured from 5:00", () => {
  assert.equal(minutesPastFive("8/22/2026 5:09:21 AM", 50), 9);
  assert.equal(minutesPastFive("8/22/2026 5:00:02 AM", 50), 0);
});

test("5:51+ is an early 6am start, not a late 5am one", () => {
  assert.equal(minutesPastFive("5:51 AM", 50), null);
  assert.equal(minutesPastFive("5:50 AM", 50), 50);
});

test("a PM scan is never a 5am start", () => {
  // The old code checked `isPM` on a meridiem it had mis-located; with the
  // hour now correct, 5 PM is simply hour 17.
  assert.equal(minutesPastFive("5:09:21 PM", 50), null);
});

test("a 6am scan is not a 5am start", () => {
  assert.equal(minutesPastFive("6:05:00 AM", 50), null);
});
