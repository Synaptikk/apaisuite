// Trip — normalized Spark dispatcher trip.
//
// Source: raw Dispatcher /v4/dashboard payload.tasksByClientId['0'].trips[].
// See notes/api_endpoints.md and notes/tools/dispatcher_mfe.md.
//
// id: stable per-trip identifier. Per app.js:373 the live response no longer
// includes batchId; we derive the same key from joined orderIds.

import { toDriver } from "./driver.js";
import { toOrder }  from "./order.js";
import { toEvidence } from "./evidence.js";

export function toTrip(raw, evidenceMeta = {}) {
  if (!raw || typeof raw !== "object") raw = {};
  const orders = (raw.orders || []).map(toOrder);
  return {
    id: orders.map(o => o.id).filter(Boolean).join("|") || null,
    storeId: raw.storeId ?? null,
    carrier: raw.carrier || "?",
    status: {
      display: raw.displayTripStatus || null,
      transit: raw.transitStatus     || null,
      delayed: raw.transitStatus === "DELAYED",
    },
    customerWindow: {
      startMs: raw.customerStartTime ? new Date(raw.customerStartTime).getTime() : null,
      endMs:   raw.customerEndTime   ? new Date(raw.customerEndTime).getTime()   : null,
    },
    driver: toDriver(raw.driver || {}),
    orders,
    evidence: toEvidence({
      source: "dispatcher",
      capturedAtMs: evidenceMeta.capturedAtMs ?? Date.now(),
      fetchedBy: evidenceMeta.fetchedBy || "live",
    }),
  };
}

// Compute the in-store window (PICKED → DISPATCHED bracket) for a normalized
// Trip. Mirrors app.js:tripInStoreWindow behaviour exactly — uses normalized
// taskEvent shape ({statusName, timeMs}) instead of raw ({eventStatus, eventTime}).
//
// IMPORTANT: PICKED/DISPATCHED status names are flagged HIGH drift risk in
// registries/enums.json#taskEventStatuses. If a viability run returns viable=0
// across all trips, suspect these strings before suspecting the user's input.
//
// Buffers (VIABILITY_PRE_BUFFER_MS / VIABILITY_POST_BUFFER_MS): the strict
// [PICKED, DISPATCHED] window misses real at-register moments because PICKED
// only fires AFTER the shopper has scanned the last item and tapped "I'm
// done" — drivers are actively at the POS for several minutes before that.
// Real-world example: register event at 14:57 EDT (driver
// confirmed at register), trip's PICKED stamped at 15:02 → strict check
// excluded the trip. With the 10-minute pre-buffer, 14:57 is now within
// (15:02 - 10m, 15:07) → trip surfaces correctly. The post-buffer mainly
// guards against clock skew on DISPATCHED.
const VIABILITY_PRE_BUFFER_MS  = 10 * 60 * 1000;
const VIABILITY_POST_BUFFER_MS =  5 * 60 * 1000;

// Does this trip's in-store presence fall within ±windowMin of the event?
//
// This is what the "Window (± minutes)" input means, and until 2026-09-03 it
// meant nothing at all: view.js floors the DISPATCHER QUERY at
// DISPATCHER_MIN_HALFWINDOW_MIN (120), because Dispatcher filters by the
// CUSTOMER promised window rather than by shopper-at-store time, and a narrow
// query therefore misses the trips we want. But `windowMin` was then used only
// to build that floor and two banner strings — nothing filtered on it. Typing 3
// and typing 120 produced identical result sets, spread across four hours.
//
// The test is intersection, not containment: the analyst's ±N is a tolerance
// around the register timestamp, and a shopper standing at the POS from
// 15:18–15:23 is a candidate for a 15:15 event at ±3 even though the bracket
// does not contain 15:15.
//
// It deliberately uses the RAW [PICKED, DISPATCHED] bracket, with no viability
// buffers — that pair is exactly what the trip card prints as "At POS between
// X→Y", so a row can never be on screen contradicting the filter that let it
// through.
//
// In-progress trips (`hasEvents: false`) come in two shapes:
//   - arrival known (`arrivedMs` set): the shopper is in the store from
//     ARRIVED_AT_STORE until now. That is a real interval, [arrivedMs, openEndMs],
//     and it is tested exactly like a PICKED→DISPATCHED bracket.
//   - arrival unknown: nothing to test, so the trip is EXEMPT and remains
//     governed by whatever computeInStoreWindow decided for viability.
export function isWithinPresenceWindow(win, eventTimestampMs, windowMin) {
  if (!Number.isFinite(windowMin) || windowMin <= 0) return true;
  if (!eventTimestampMs) return true;
  const half = windowMin * 60 * 1000;
  if (win?.hasEvents) {
    return win.pickedMs <= eventTimestampMs + half &&
           win.dispatchedMs >= eventTimestampMs - half;
  }
  if (win?.arrivedMs && win?.openEndMs) {
    return win.arrivedMs <= eventTimestampMs + half &&
           win.openEndMs  >= eventTimestampMs - half;
  }
  return true;
}

// Dispatcher's per-order taskEvents chain, in lifecycle order (observed on the
// live /v4/dashboard payload, recon/archive/artifacts/dispatcher_today_v2.json):
//   COURIER_REQUESTED → ENROUTE_TO_PICKUP → ARRIVED_AT_STORE → PICK_STARTED →
//   PICKED → DISPATCHED → ENROUTE_TO_DROPOFF → ARRIVED_AT_CUSTOMERS_LOCATION → DELIVERED
// ARRIVED_AT_STORE is the first moment the shopper is physically inside.
// PICK_STARTED is the fallback when arrival didn't fire — it can only happen
// in the store, so it is a late-but-safe lower bound.
const ARRIVAL_EVENTS = ["ARRIVED_AT_STORE", "PICK_STARTED"];
const ACTIVE_STATUSES = new Set(["enrouteToPickup", "atPickup", "tripInProgress"]);
// Statuses that assert the shopper is inside the store even if the arrival
// event is missing from the payload (drift guard — see enums.json drift_risk).
const IN_STORE_STATUSES = new Set(["atPickup", "tripInProgress"]);

export function computeInStoreWindow(trip, eventTimestampMs, nowMs = Date.now()) {
  let earliestPicked = null;
  let latestDispatched = null;
  let earliestArrived = null;
  let earliestPickStarted = null;
  for (const order of trip.orders) {
    for (const e of order.taskEvents) {
      if (e.statusName === "PICKED") {
        if (earliestPicked === null || e.timeMs < earliestPicked) earliestPicked = e.timeMs;
      } else if (e.statusName === "DISPATCHED") {
        if (latestDispatched === null || e.timeMs > latestDispatched) latestDispatched = e.timeMs;
      } else if (e.statusName === ARRIVAL_EVENTS[0]) {
        if (earliestArrived === null || e.timeMs < earliestArrived) earliestArrived = e.timeMs;
      } else if (e.statusName === ARRIVAL_EVENTS[1]) {
        if (earliestPickStarted === null || e.timeMs < earliestPickStarted) earliestPickStarted = e.timeMs;
      }
    }
  }
  const hasEvents = earliestPicked !== null && latestDispatched !== null;

  // Active in-progress trips without PICKED/DISPATCHED. The shopper may be in
  // the store right now, but "right now" is not the event time: an analyst
  // searching 14:40 at 16:30 was getting every shopper currently picking,
  // because viability fell back to the customer's promised delivery window
  // (typically 3-4 hours wide). Use the moment the shopper actually walked
  // in instead — ARRIVED_AT_STORE (or PICK_STARTED) — as an open-ended
  // bracket [arrived, now]. A 14:40 event against a 16:10 arrival is not
  // viable; a 16:20 event is.
  if (!hasEvents && eventTimestampMs) {
    const isActive = ACTIVE_STATUSES.has(trip.status?.display);
    const arrivedMs = earliestArrived ?? earliestPickStarted;
    if (isActive && arrivedMs !== null) {
      const viable =
        eventTimestampMs >= arrivedMs - VIABILITY_PRE_BUFFER_MS &&
        eventTimestampMs <= nowMs     + VIABILITY_POST_BUFFER_MS;
      return {
        pickedMs: null,
        dispatchedMs: null,
        durationMin: null,
        hasEvents: false,
        viable,
        inProgress: true,
        arrivedMs,
        arrivalSource: earliestArrived !== null ? ARRIVAL_EVENTS[0] : ARRIVAL_EVENTS[1],
        openEndMs: nowMs,
      };
    }
    // No arrival event. If the status itself says "in store" the event name
    // has probably drifted — keep the old customer-window fallback so the
    // trip still surfaces (UNKNOWN confidence) rather than vanishing. If the
    // status is enrouteToPickup, the shopper has not arrived and cannot have
    // been at a register at any past time.
    const inStoreByStatus = IN_STORE_STATUSES.has(trip.status?.display);
    const cwStart = trip.customerWindow?.startMs;
    const cwEnd   = trip.customerWindow?.endMs;
    const inWindow = !!(cwStart && cwEnd &&
      eventTimestampMs >= cwStart - VIABILITY_PRE_BUFFER_MS &&
      eventTimestampMs <= cwEnd   + VIABILITY_POST_BUFFER_MS);
    return {
      pickedMs: null,
      dispatchedMs: null,
      durationMin: null,
      hasEvents: false,
      viable: inStoreByStatus && inWindow,
      inProgress: isActive,
      arrivedMs: null,
      arrivalSource: null,
      openEndMs: null,
    };
  }

  const viable = !!(
    eventTimestampMs &&
    hasEvents &&
    eventTimestampMs >= earliestPicked  - VIABILITY_PRE_BUFFER_MS &&
    eventTimestampMs <= latestDispatched + VIABILITY_POST_BUFFER_MS
  );
  return {
    pickedMs: earliestPicked,
    dispatchedMs: latestDispatched,
    durationMin: hasEvents ? Math.round((latestDispatched - earliestPicked) / 60000) : null,
    hasEvents,
    viable,
  };
}
