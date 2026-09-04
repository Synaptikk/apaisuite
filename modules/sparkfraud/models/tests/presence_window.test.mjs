// node --test modules/sparkfraud/models/tests/presence_window.test.mjs
//
// Pins the "Window (± minutes)" filter. Until 2026-09-03 that input was inert
// below 120: it only fed Math.max(windowMin, DISPATCHER_MIN_HALFWINDOW_MIN) and
// two banner strings, so a ±3m search rendered four hours of trips.
//
// Times below are the real store-1458 result set from the report, event at
// 15:15 EDT on 2026-09-03.

import test from "node:test";
import assert from "node:assert/strict";

import { isWithinPresenceWindow } from "../trip.js";

const EDT = "-04:00";
const at = hhmm => new Date(`2026-09-03T${hhmm}:00${EDT}`).getTime();

const EVENT = at("15:15");

const bracket = (from, to) => ({
  hasEvents: true,
  pickedMs: at(from),
  dispatchedMs: at(to),
});

// No PICKED/DISPATCHED — computeInStoreWindow's in-progress fallback shape.
const inProgress = { hasEvents: false, pickedMs: null, dispatchedMs: null };

test("±3m keeps the three trips whose POS time touches the window", () => {
  // Keanu Lilly, MONEETT DAVIS, Laine Christopher.
  for (const [from, to] of [["15:18", "15:23"], ["15:17", "15:30"], ["15:11", "15:15"]]) {
    assert.equal(isWithinPresenceWindow(bracket(from, to), EVENT, 3), true, `${from}→${to}`);
  }
});

test("the test is intersection, not containment", () => {
  // 15:18→15:23 does not CONTAIN 15:15, but a shopper at the register three
  // minutes after the event is exactly what ±3 is asking for.
  const win = bracket("15:18", "15:23");
  assert.equal(win.pickedMs > EVENT, true);
  assert.equal(isWithinPresenceWindow(win, EVENT, 3), true);
});

test("±3m drops POS windows that are genuinely far off", () => {
  for (const [from, to] of [["13:30", "13:50"], ["16:40", "17:05"], ["15:19", "15:40"]]) {
    assert.equal(isWithinPresenceWindow(bracket(from, to), EVENT, 3), false, `${from}→${to}`);
  }
});

test("widening admits what ±3m excluded", () => {
  const win = bracket("16:40", "17:05");
  assert.equal(isWithinPresenceWindow(win, EVENT, 3), false);
  assert.equal(isWithinPresenceWindow(win, EVENT, 120), true);
});

test("boundaries are inclusive", () => {
  // Bracket ending exactly at event − 3m, and starting exactly at event + 3m.
  assert.equal(isWithinPresenceWindow(bracket("15:00", "15:12"), EVENT, 3), true);
  assert.equal(isWithinPresenceWindow(bracket("15:18", "15:30"), EVENT, 3), true);
  // One minute further out on each side fails.
  assert.equal(isWithinPresenceWindow(bracket("15:00", "15:11"), EVENT, 3), false);
  assert.equal(isWithinPresenceWindow(bracket("15:19", "15:30"), EVENT, 3), false);
});

test("in-progress trips (no POS bracket) are exempt", () => {
  // Latisha Stafford / ANDREW BROWN. They have no in-store interval, so this
  // filter has nothing to test and must not silently decide either way — they
  // stay governed by the customer-window viability fallback.
  assert.equal(isWithinPresenceWindow(inProgress, EVENT, 3), true);
  assert.equal(isWithinPresenceWindow(inProgress, EVENT, 240), true);
});

test("no window / no event time disables the filter", () => {
  const far = bracket("13:30", "13:50");
  for (const n of [null, undefined, 0, -5, NaN]) {
    assert.equal(isWithinPresenceWindow(far, EVENT, n), true, String(n));
  }
  // Lookup mode: no event time to be ±N of.
  assert.equal(isWithinPresenceWindow(far, null, 3), true);
});
