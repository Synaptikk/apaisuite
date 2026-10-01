// modules/digitalrollup/lib/tests/pick_days.test.mjs
//
// The per-day archive behind Digital Metrics' Pick Hours tab. What breaks in
// production: a mid-day source reset overwriting measured hours with an
// averaged block, a partial hour never becoming final, and days piling up.
//
// Run with: node --test modules/digitalrollup/lib/tests/pick_days.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  upsertDay, listDays, mergeDay, dayKeyFor, storeKey, hoursByClock, peakHour, MAX_DAYS_PER_STORE,
} from "../pick_days.js";
import { hourlyBars } from "../pick_history.js";

const HOUR = 3600e3;
// A board day starting 5 AM local on 2026-09-26.
const DAY_START = new Date(2026, 8, 26, 5, 0).getTime();
const at = (h, m = 0) => DAY_START + (h - 5) * HOUR + m * 60e3;

/** Samples every 5 minutes at a flat rate, from `fromH` to `toH` (clock hours). */
function samples(fromH, toH, perHour = 600, startTotal = 0) {
  const out = [];
  for (let t = at(fromH); t <= at(toH); t += 5 * 60e3) out.push([t, Math.round(startTotal + (t - at(fromH)) * perHour / HOUR)]);
  return out;
}

test("dayKeyFor keys on the board day start, not the reading's calendar date", () => {
  assert.equal(dayKeyFor(DAY_START), "2026-09-26");
  // 2 AM the next calendar day still belongs to the 09-26 board day.
  assert.equal(dayKeyFor(DAY_START), dayKeyFor(new Date(2026, 8, 26, 5, 0).getTime()));
});

test("storeKey folds padded and numeric forms together", () => {
  assert.equal(storeKey("01458"), "1458");
  assert.equal(storeKey(1458), "1458");
  assert.equal(storeKey("abc"), null);
  assert.equal(storeKey(null), null);
});

test("upsertDay records a day and a later upsert finalises its partial hour", () => {
  const day1 = hourlyBars(samples(6, 7, 600), DAY_START);   // 6a–7a measured, 7a "now" (one reading)
  let archive = upsertDay(null, { store: "01458", day: day1, market: "120", reportDate: "2026-09-26", samples: 13, now: 1 });
  const rec1 = archive.days["1458"]["2026-09-26"];
  assert.ok(rec1, "record keyed by numeric store and board day");
  assert.equal(rec1.market, "120");
  assert.ok(rec1.before, "5a–6a before recording is kept as the averaged block");

  // 6a, 7a measured; one reading ten minutes into 8a makes that hour "now".
  const day2 = hourlyBars([...samples(6, 8, 600), [at(8, 10), 1300]], DAY_START);
  archive = upsertDay(archive, { store: 1458, day: day2, samples: 25, now: 2 });
  const rec2 = archive.days["1458"]["2026-09-26"];
  const seven = rec2.hours.find((h) => h.start === at(7));
  assert.equal(seven.kind, "hour", "7a was partial, now measured");
  assert.equal(seven.picked, 600);
  assert.equal(rec2.hours.at(-1).kind, "now");
  assert.equal(rec2.total, day2.total);
  assert.equal(rec2.samples, 25);
  assert.equal(rec2.updatedAt, 2);
  assert.equal(Object.keys(archive.days).length, 1, "01458 and 1458 are the same store");
});

test("a mid-day series reset keeps the measured morning and never re-averages it", () => {
  // Morning recorded from the day start: no `before`, 5a..9a measured.
  const morning = hourlyBars(samples(5, 10, 600), DAY_START);
  let archive = upsertDay(null, { store: "1458", day: morning, now: 1 });
  assert.equal(archive.days["1458"]["2026-09-26"].before, null);

  // Source reset at 10a: the rolling series restarts, so its hourlyBars sees
  // only 10a.. and presents 5a–10a as one averaged `before` block.
  const afterReset = hourlyBars(samples(10, 12, 500), DAY_START);
  assert.ok(afterReset.before, "precondition: the fresh series does show a before block");
  archive = upsertDay(archive, { store: "1458", day: afterReset, now: 2 });

  const rec = archive.days["1458"]["2026-09-26"];
  assert.equal(rec.before, null, "the measured morning is not replaced by an average");
  const starts = rec.hours.map((h) => h.start);
  for (let h = 5; h <= 11; h++) assert.ok(starts.includes(at(h)), `hour ${h} present`);
  assert.equal(rec.hours.find((h) => h.start === at(6)).picked, 600, "morning hours untouched");
  assert.equal(rec.hours.find((h) => h.start === at(10)).picked, 500, "post-reset hours added");
});

test("mergeDay keeps the later of two partial readings and the max total", () => {
  const a = { dayStart: DAY_START, asOf: at(8, 10), total: 100, hours: [{ start: at(8), end: at(8, 10), picked: 10, kind: "now" }] };
  const b = { dayStart: DAY_START, asOf: at(8, 40), total: 140, hours: [{ start: at(8), end: at(8, 40), picked: 50, kind: "now" }] };
  assert.equal(mergeDay(a, b).hours[0].picked, 50);
  assert.equal(mergeDay(b, a).hours[0].picked, 50, "order does not matter");
  assert.equal(mergeDay(b, a).total, 140);
});

test("upsertDay ignores empty computations and leaves the archive intact", () => {
  const before = upsertDay(null, { store: "1458", day: hourlyBars(samples(6, 7), DAY_START) });
  assert.equal(upsertDay(before, { store: "1458", day: null }), before);
  assert.deepEqual(upsertDay(null, { store: "nope", day: hourlyBars(samples(6, 7), DAY_START) }), { v: 1, days: {} });
});

test("days are capped per store, oldest dropped", () => {
  let archive = null;
  for (let i = 0; i < MAX_DAYS_PER_STORE + 5; i++) {
    const start = DAY_START - i * 24 * HOUR;
    const day = { dayStart: start, asOf: start + 2 * HOUR, total: 100, dayAvgPerHour: 50, before: null,
                  hours: [{ start: start + HOUR, end: start + 2 * HOUR, picked: 100, kind: "hour" }] };
    archive = upsertDay(archive, { store: "1458", day });
  }
  const keys = Object.keys(archive.days["1458"]).sort();
  assert.equal(keys.length, MAX_DAYS_PER_STORE);
  assert.equal(keys.at(-1), "2026-09-26", "newest kept");
});

test("listDays is newest first and marks only the newest day open", () => {
  let archive = null;
  for (const d of [24, 26, 25]) {
    const start = new Date(2026, 8, d, 5, 0).getTime();
    archive = upsertDay(archive, { store: "1458", day: {
      dayStart: start, asOf: start + HOUR, total: 10 * d, dayAvgPerHour: 1, before: null,
      hours: [{ start, end: start + HOUR, picked: 10 * d, kind: "now" }],
    } });
  }
  const days = listDays(archive, "01458");
  assert.deepEqual(days.map((d) => d.key), ["2026-09-26", "2026-09-25", "2026-09-24"]);
  assert.deepEqual(days.map((d) => d.closed), [false, true, true]);
  assert.equal(days[0].total, 260);
  assert.deepEqual(listDays(archive, "9999"), []);
  assert.deepEqual(listDays(null, "1458"), []);
});

test("hoursByClock and peakHour read a record", () => {
  const rec = { hours: [
    { start: at(6), end: at(7), picked: 300, kind: "hour" },
    { start: at(7), end: at(8), picked: 900, kind: "hour" },
    { start: at(8), end: at(8, 30), picked: 100, kind: "now" },
  ] };
  assert.equal(hoursByClock(rec).get(7).picked, 900);
  assert.equal(peakHour(rec).start, at(7));
  assert.equal(peakHour({ hours: [] }), null);
});
