// CandidateMatch — investigative lead with calibrated confidence label.
//
// Per docs/ARCHITECTURE.md confidence model and Shane's CANDIDATE-01 spec:
// these labels represent investigative lead QUALITY ONLY. They do NOT
// represent guilt or proof. Outputs are reviewable evidence, never accusations.
//
// Decision rules are intentionally a one-way function: the first matching case
// returns. There is no upgrade path. Never silently elevate a label.
//
// Inputs:
//   normalizedTrip  — from toTrip() in models/trip.js
//   context = {
//     eventTimestampMs:  number | null    (null → UNKNOWN)
//     allCandidateTrips: NormalizedTrip[] (for competing-overlap detection)
//     lookupMode:        bool             (true → VERIFIED by direct lookup)
//   }
//
// Output:
//   CandidateMatch = { trip, confidence, rationale[], ambiguity[], metrics }

import { computeInStoreWindow } from "./trip.js";

export const CONFIDENCE = Object.freeze({
  VERIFIED:    "VERIFIED",
  LIKELY:      "LIKELY",
  POSSIBLE:    "POSSIBLE",
  UNKNOWN:     "UNKNOWN",
  CONFLICTING: "CONFLICTING",
});

// Calibrated thresholds — sign-off recorded in docs/DISCOVERIES.md 2026-05-22.
// Any change to these numbers MUST update the confidence rules in
// docs/ARCHITECTURE.md and re-log in DISCOVERIES (calibration is a domain
// decision, not an engineering one).
const LIKELY_MIN_WINDOW_MIN   = 4;
const POSSIBLE_MAX_WINDOW_MIN = 2;
const NEAR_BOUNDARY_SECONDS   = 60;

export function assessConfidence(trip, context = {}) {
  const rationale = [];
  const ambiguity = [];
  const metrics = {
    sourcesCount: 1,                // Dispatcher only in v0; multi-source pending
    durationMin: null,
    boundaryProximitySec: null,
    competingViableTrips: null,
    eventInsideWindow: null,
    hasTaskEvents: null,
  };

  // ── VERIFIED — explicit unique-identifier match ─────────────────────
  if (context.lookupMode) {
    rationale.push("Direct order lookup by known order ID — explicit unique identifier match");
    return finalize(CONFIDENCE.VERIFIED, rationale, ambiguity, metrics);
  }

  // ── UNKNOWN — missing critical timing data ───────────────────────────
  const win = computeInStoreWindow(trip, context.eventTimestampMs);
  metrics.durationMin   = win.durationMin;
  metrics.hasTaskEvents = win.hasEvents;
  metrics.eventInsideWindow = win.viable;

  if (!win.hasEvents) {
    rationale.push("Missing PICKED/DISPATCHED taskEvents — incomplete dispatcher lifecycle");
    ambiguity.push("Cannot establish in-store window without taskEvents");
    return finalize(CONFIDENCE.UNKNOWN, rationale, ambiguity, metrics);
  }

  if (!context.eventTimestampMs) {
    rationale.push("No event timestamp provided — cannot establish timing confidence");
    ambiguity.push("Event time required for window-overlap assessment");
    return finalize(CONFIDENCE.UNKNOWN, rationale, ambiguity, metrics);
  }

  // ── UNKNOWN — event outside trip window (shouldn't reach here for
  //              viable-filtered candidates, but defensive) ─────────────
  if (!win.viable) {
    rationale.push(
      `Event time falls outside in-store window (PICKED→DISPATCHED, ${win.durationMin}m)`
    );
    ambiguity.push("Trip's in-store window does not contain event time");
    return finalize(CONFIDENCE.UNKNOWN, rationale, ambiguity, metrics);
  }

  // ── CONFLICTING — competing overlapping viable trips ────────────────
  const competing = (context.allCandidateTrips || []).filter(t => {
    if (t === trip) return false;
    return computeInStoreWindow(t, context.eventTimestampMs).viable;
  });
  metrics.competingViableTrips = competing.length;

  if (competing.length > 0) {
    rationale.push("Multiple overlapping viable trips — register/time alignment ambiguous");
    ambiguity.push(
      `${competing.length} other trip(s) also viable for this timestamp; ` +
      `cannot distinguish without additional evidence`
    );
    return finalize(CONFIDENCE.CONFLICTING, rationale, ambiguity, metrics);
  }

  // ── POSSIBLE — timestamp near trip boundary ─────────────────────────
  const distPickedSec     = Math.abs(context.eventTimestampMs - win.pickedMs)     / 1000;
  const distDispatchedSec = Math.abs(context.eventTimestampMs - win.dispatchedMs) / 1000;
  const boundaryDistSec   = Math.min(distPickedSec, distDispatchedSec);
  metrics.boundaryProximitySec = Math.round(boundaryDistSec);

  if (boundaryDistSec < NEAR_BOUNDARY_SECONDS) {
    rationale.push(
      `Event time near trip boundary (${Math.round(boundaryDistSec)}s from PICKED or DISPATCHED)`
    );
    ambiguity.push("Boundary proximity could indicate timestamp jitter — weaker timing confidence");
    appendSingleSourceCaveat(ambiguity, metrics);
    return finalize(CONFIDENCE.POSSIBLE, rationale, ambiguity, metrics);
  }

  // ── POSSIBLE — small overlap window ─────────────────────────────────
  if (win.durationMin <= POSSIBLE_MAX_WINDOW_MIN) {
    rationale.push(
      `Small overlap window (${win.durationMin}m, ≤${POSSIBLE_MAX_WINDOW_MIN}m threshold)`
    );
    ambiguity.push("Tight window — weaker timing confidence");
    appendSingleSourceCaveat(ambiguity, metrics);
    return finalize(CONFIDENCE.POSSIBLE, rationale, ambiguity, metrics);
  }

  // ── LIKELY — wide window, no competition, no boundary issue ─────────
  if (win.durationMin >= LIKELY_MIN_WINDOW_MIN) {
    rationale.push(
      `Event time clearly within active in-store window ` +
      `(${win.durationMin}m, ≥${LIKELY_MIN_WINDOW_MIN}m threshold)`
    );
    rationale.push("No competing overlapping viable candidate trips");
    appendSingleSourceCaveat(ambiguity, metrics);
    return finalize(CONFIDENCE.LIKELY, rationale, ambiguity, metrics);
  }

  // ── POSSIBLE — intermediate window (3m: between thresholds) ─────────
  // Conservative: never silently upgrade to LIKELY.
  rationale.push(
    `Intermediate overlap window (${win.durationMin}m, between POSSIBLE ` +
    `≤${POSSIBLE_MAX_WINDOW_MIN}m and LIKELY ≥${LIKELY_MIN_WINDOW_MIN}m thresholds)`
  );
  ambiguity.push("Window width in ambiguous range — conservative POSSIBLE rather than LIKELY");
  appendSingleSourceCaveat(ambiguity, metrics);
  return finalize(CONFIDENCE.POSSIBLE, rationale, ambiguity, metrics);
}

function appendSingleSourceCaveat(ambiguity, metrics) {
  if (metrics.sourcesCount === 1) {
    ambiguity.push("Single-source evidence (Dispatcher taskEvents only); multi-source corroboration unavailable in v0");
  }
}

function finalize(label, rationale, ambiguity, metrics) {
  return { label, rationale, ambiguity, metrics };
}

// Wraps a normalized Trip into a CandidateMatch with confidence assessment.
export function toCandidateMatch(trip, context = {}) {
  const a = assessConfidence(trip, context);
  return {
    trip,
    confidence: a.label,
    rationale: a.rationale,
    ambiguity: a.ambiguity,
    metrics: a.metrics,
  };
}
