// node --test modules/sparkfraud/models/tests/in_progress_window.test.mjs
//
// Pins how in-progress trips (no PICKED/DISPATCHED yet) are judged viable.
// Until 2026-09-04 they fell back to the customer's promised delivery window,
// which is 3-4 hours wide: an analyst searching 14:40 at 16:30 got every
// shopper currently picking, including ones who walked in at 16:10.
//
// Dispatcher's taskEvents chain carries ARRIVED_AT_STORE and PICK_STARTED,
// so the bracket is [arrival, now] — open-ended, but with a real start.
// Times below are the store-1458 case from the report: event at 14:40 EDT,
// searched at 16:30 EDT on 2026-09-04.

import test from "node:test";
import assert from "node:assert/strict";

import { computeInStoreWindow, isWithinPresenceWindow } from "../trip.js";

const EDT = "-04:00";
const at = hhmm => new Date(`2026-09-04T${hhmm}:00${EDT}`).getTime();

const EVENT = at("14:40");
const NOW   = at("16:30");

function trip({ status, events = [], window = ["14:33", "18:00"] }) {
  return {
    status: { display: status },
    customerWindow: { startMs: at(window[0]), endMs: at(window[1]) },
    orders: [{
      taskEvents: events.map(([statusName, hhmm]) => ({ statusName, timeMs: at(hhmm) })),
    }],
  };
}

test("a shopper who arrived after the event is not viable", () => {
  // Janine Mollica: atPickup, customer window 14:33–18:00 (contains 14:40),
  // but ARRIVED_AT_STORE at 16:10. Old code: viable. New code: no.
  const t = trip({ status: "atPickup", events: [["ENROUTE_TO_PICKUP", "15:55"], ["ARRIVED_AT_STORE", "16:10"]] });
  const win = computeInStoreWindow(t, EVENT, NOW);
  assert.equal(win.hasEvents, false);
  assert.equal(win.inProgress, true);
  assert.equal(win.arrivedMs, at("16:10"));
  assert.equal(win.arrivalSource, "ARRIVED_AT_STORE");
  assert.equal(win.viable, false);
});

test("a shopper who arrived before the event and is still inside is viable", () => {
  const t = trip({ status: "tripInProgress", events: [["ARRIVED_AT_STORE", "14:25"], ["PICK_STARTED", "14:28"]] });
  const win = computeInStoreWindow(t, EVENT, NOW);
  assert.equal(win.viable, true);
  assert.equal(win.openEndMs, NOW);
});

test("the 10-minute pre-buffer applies to arrival like it does to PICKED", () => {
  // Arrived 14:47; event 14:40 is 7 minutes before — inside the pre-buffer.
  assert.equal(computeInStoreWindow(trip({ status: "atPickup", events: [["ARRIVED_AT_STORE", "14:47"]] }), EVENT, NOW).viable, true);
  // Arrived 14:51; 11 minutes — outside.
  assert.equal(computeInStoreWindow(trip({ status: "atPickup", events: [["ARRIVED_AT_STORE", "14:51"]] }), EVENT, NOW).viable, false);
});

test("PICK_STARTED stands in when ARRIVED_AT_STORE is missing", () => {
  const t = trip({ status: "tripInProgress", events: [["PICK_STARTED", "16:12"]] });
  const win = computeInStoreWindow(t, EVENT, NOW);
  assert.equal(win.arrivedMs, at("16:12"));
  assert.equal(win.arrivalSource, "PICK_STARTED");
  assert.equal(win.viable, false);
});

test("enrouteToPickup with no arrival event is never viable for a past event", () => {
  // The shopper has not walked in; the customer window containing the event
  // time means nothing.
  const t = trip({ status: "enrouteToPickup", events: [["COURIER_REQUESTED", "14:30"], ["ENROUTE_TO_PICKUP", "14:35"]] });
  const win = computeInStoreWindow(t, EVENT, NOW);
  assert.equal(win.inProgress, true);
  assert.equal(win.arrivedMs, null);
  assert.equal(win.viable, false);
});

test("in-store status with no arrival event keeps the customer-window fallback (drift guard)", () => {
  // If Walmart renames ARRIVED_AT_STORE, trips whose status already says
  // "in store" must still surface rather than silently vanish.
  const t = trip({ status: "atPickup", events: [["COURIER_REQUESTED", "14:30"]] });
  const win = computeInStoreWindow(t, EVENT, NOW);
  assert.equal(win.arrivedMs, null);
  assert.equal(win.viable, true);
  // …but not when the event is outside the customer window either.
  const t2 = trip({ status: "atPickup", events: [], window: ["15:30", "18:00"] });
  assert.equal(computeInStoreWindow(t2, EVENT, NOW).viable, false);
});

test("completed trips are unaffected: PICKED→DISPATCHED still wins", () => {
  const t = trip({ status: "completed", events: [["ARRIVED_AT_STORE", "14:20"], ["PICKED", "14:39"], ["DISPATCHED", "14:41"]] });
  const win = computeInStoreWindow(t, EVENT, NOW);
  assert.equal(win.hasEvents, true);
  assert.equal(win.pickedMs, at("14:39"));
  assert.equal(win.viable, true);
  assert.equal(win.arrivedMs, undefined);
});

test("±N window filter tests the [arrival, now] bracket when arrival is known", () => {
  const known = { hasEvents: false, arrivedMs: at("16:10"), openEndMs: NOW };
  assert.equal(isWithinPresenceWindow(known, EVENT, 30), false);
  assert.equal(isWithinPresenceWindow(known, EVENT, 120), true);
  // Arrival unknown: still exempt, as before.
  const unknown = { hasEvents: false, arrivedMs: null, openEndMs: null };
  assert.equal(isWithinPresenceWindow(unknown, EVENT, 3), true);
});
