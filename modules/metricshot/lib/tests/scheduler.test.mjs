// modules/metricshot/lib/tests/scheduler.test.mjs
//
// Run with: node --test modules/metricshot/lib/tests/scheduler.test.mjs
//
// Pure-function tests for the scheduler. No chrome.* usage — the scheduler
// is deliberately stateless so it can be tested in a plain Node runtime.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expandDueRuns,
  keyFor,
  partsInZone,
  nextRun,
  isAllWeek,
  resolveZone,
} from "../scheduler.js";

const UTC = "UTC";

function m(overrides = {}) {
  return {
    id: "test-metric",
    name: "T",
    url: "https://example.com/",
    enabled: true,
    timezone: UTC,
    schedules: [
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "10:00" },
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "14:00" },
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "20:00" },
    ],
    capture: { catchUpWindowMs: 60 * 60 * 1000 },
    ...overrides,
  };
}

function utc(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

test("expandDueRuns: no runs when metric is disabled", () => {
  const now = utc(2026, 7, 27, 10, 0);
  const due = expandDueRuns(m({ enabled: false }), now);
  assert.deepEqual(due, []);
});

test("expandDueRuns: returns the just-passed slot at exact minute", () => {
  const now = utc(2026, 7, 27, 10, 0);
  const due = expandDueRuns(m(), now);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledFor.hhmm, "10:00");
  assert.equal(due[0].scheduledFor.yyyyMMdd, "2026-07-27");
  assert.equal(due[0].stale, false);
});

test("expandDueRuns: slot 30 min old is due, not stale (60min window)", () => {
  const now = utc(2026, 7, 27, 10, 30);
  const due = expandDueRuns(m(), now);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledFor.hhmm, "10:00");
  assert.equal(due[0].stale, false);
});

test("expandDueRuns: slot >window is returned but marked stale", () => {
  const now = utc(2026, 7, 27, 12, 30);   // 2.5h after 10:00 slot; 14:00 slot in future
  const due = expandDueRuns(m(), now);
  const tenAm = due.find((r) => r.scheduledFor.hhmm === "10:00");
  assert.ok(tenAm, "10:00 slot should be present");
  assert.equal(tenAm.stale, true);
});

test("expandDueRuns: no future slots included", () => {
  const now = utc(2026, 7, 27, 13, 0);   // 14:00 hasn't happened
  const due = expandDueRuns(m(), now);
  for (const r of due) {
    assert.ok(r.scheduledAt <= now, `future slot leaked: ${r.scheduledFor.hhmm}`);
  }
});

test("expandDueRuns: crosses midnight — yesterday's 23:30 slot in scope at 00:15", () => {
  const late = m({ schedules: [{ days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "23:30" }] });
  const now = utc(2026, 7, 27, 0, 15);
  const due = expandDueRuns(late, now);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledFor.hhmm, "23:30");
  assert.equal(due[0].scheduledFor.yyyyMMdd, "2026-07-26");
  assert.equal(due[0].stale, false);
});

test("expandDueRuns: keys are deterministic across calls", () => {
  const now = utc(2026, 7, 27, 14, 0);
  const a = expandDueRuns(m(), now);
  const b = expandDueRuns(m(), now);
  assert.deepEqual(a.map((r) => r.runKey), b.map((r) => r.runKey));
  // At 14:00 exactly, both the 10:00 slot (stale — 4h > 60min window) and
  // the 14:00 slot (fresh) are returned. The 20:00 slot is future — not returned.
  const fresh = a.filter((r) => !r.stale).map((r) => r.runKey);
  assert.deepEqual(fresh, ["test-metric:2026-07-27:14:00"]);
});

test("expandDueRuns: no duplicate keys within one call", () => {
  const now = utc(2026, 7, 27, 14, 5);
  const withDupe = m({
    schedules: [
      { days: ["MON","TUE","WED","THU","FRI"], time: "14:00" },
      { days: ["MON"],                          time: "14:00" },   // duplicate for Mon
    ],
  });
  const due = expandDueRuns(withDupe, now);
  const keys = due.map((r) => r.runKey);
  assert.equal(new Set(keys).size, keys.length, "no duplicate runKeys");
});

test("expandDueRuns: DST spring-forward — no slot at 02:30 America/New_York (does not exist)", () => {
  // 2026-03-08 in America/New_York: clocks jump from 02:00 → 03:00 EDT.
  // A 02:30 slot on that Sunday should not fire (no wall-clock time equals 02:30).
  const withDst = m({
    timezone: "America/New_York",
    schedules: [{ days: ["SUN"], time: "02:30" }],
  });
  const nowNY = utc(2026, 3, 8, 8, 0);   // 04:00 New York (post-DST)
  const due = expandDueRuns(withDst, nowNY);
  // The 02:30 slot never occurred; findLocalEpoch shouldn't find a match.
  assert.equal(due.length, 0);
});

test("expandDueRuns: DST fall-back — 01:30 America/New_York fires once", () => {
  // 2026-11-01: clocks fall back from 02:00 EDT → 01:00 EST. A 01:30 slot
  // occurs TWICE in wall-clock — but our search returns just the most recent
  // matching epoch (first hit going backward), which is fine for dedupe.
  const withDst = m({
    timezone: "America/New_York",
    schedules: [{ days: ["SUN"], time: "01:30" }],
  });
  const nowNY = utc(2026, 11, 1, 7, 0);   // 02:00 EST after fallback
  const due = expandDueRuns(withDst, nowNY);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledFor.hhmm, "01:30");
});

test("keyFor: matches convention <id>:<date>:<time>", () => {
  assert.equal(keyFor("m", "2026-07-27", "14:00"), "m:2026-07-27:14:00");
});

test("partsInZone: matches Intl output for a known instant", () => {
  const p = partsInZone(utc(2026, 7, 27, 19, 0), "America/Chicago");
  assert.equal(p.yyyyMMdd, "2026-07-27");
  assert.equal(p.hh, 14);
  assert.equal(p.mm, 0);
  assert.equal(p.dow, "MON");
});

test("nextRun: finds the next scheduled slot", () => {
  const now = utc(2026, 7, 27, 13, 5);   // Monday 13:05 UTC — next is 14:00
  const next = nextRun(m(), now);
  assert.ok(next);
  assert.equal(next.label, "MON 14:00");
});

test("isAllWeek", () => {
  assert.equal(isAllWeek(["MON","TUE","WED","THU","FRI","SAT","SUN"]), true);
  assert.equal(isAllWeek(["MON","TUE","WED","THU","FRI"]), false);
  assert.equal(isAllWeek([]), false);
});

test("resolveZone: 'local' resolves to the runtime timezone", () => {
  const z = resolveZone("local");
  assert.ok(z);
  assert.equal(z, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
});
