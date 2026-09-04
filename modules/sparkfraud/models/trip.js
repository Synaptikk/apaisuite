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
// Trips with no bracket (`hasEvents: false` — the in-progress fallback in
// computeInStoreWindow) are EXEMPT. They have no in-store interval to test, so
// there is nothing here that could include or exclude them honestly; they
// remain governed by the customer-window viability fallback. Callers that want
// them gone want a different filter, not this one.
export function isWithinPresenceWindow(win, eventTimestampMs, windowMin) {
  if (!Number.isFinite(windowMin) || windowMin <= 0) return true;
  if (!eventTimestampMs) return true;
  if (!win?.hasEvents) return true;
  const half = windowMin * 60 * 1000;
  return win.pickedMs <= eventTimestampMs + half &&
         win.dispatchedMs >= eventTimestampMs - half;
}

export function computeInStoreWindow(trip, eventTimestampMs) {
  let earliestPicked = null;
  let latestDispatched = null;
  for (const order of trip.orders) {
    for (const e of order.taskEvents) {
      if (e.statusName === "PICKED") {
        if (earliestPicked === null || e.timeMs < earliestPicked) earliestPicked = e.timeMs;
      } else if (e.statusName === "DISPATCHED") {
        if (latestDispatched === null || e.timeMs > latestDispatched) latestDispatched = e.timeMs;
      }
    }
  }
  const hasEvents = earliestPicked !== null && latestDispatched !== null;

  // Active in-progress trips without PICKED/DISPATCHED: fall back to the
  // customer delivery window for viability. The shopper is physically in
  // the store but hasn't completed picking yet. In-store register window
  // isn't bracketable, but the event time within the promised window is a
  // meaningful lead worth surfacing (UNKNOWN confidence, not dropped).
  if (!hasEvents && eventTimestampMs) {
    const ACTIVE = new Set(["enrouteToPickup", "atPickup", "tripInProgress"]);
    const cwStart = trip.customerWindow?.startMs;
    const cwEnd   = trip.customerWindow?.endMs;
    const isActive = ACTIVE.has(trip.status?.display);
    const inWindow = !!(cwStart && cwEnd &&
      eventTimestampMs >= cwStart - VIABILITY_PRE_BUFFER_MS &&
      eventTimestampMs <= cwEnd   + VIABILITY_POST_BUFFER_MS);
    return {
      pickedMs: null,
      dispatchedMs: null,
      durationMin: null,
      hasEvents: false,
      viable: isActive && inWindow,
      inProgress: isActive,
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
