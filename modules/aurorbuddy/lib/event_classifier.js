// lib/event_classifier.js — per-event documentation-status classifier
// ────────────────────────────────────────────────────────────────────────────
// JS port of pipeline/event_classifier.py.
//
// This is the single place that decides, for each APPRISS event the AP
// officer is looking at: is this event already keyed in Auror
// (documented), or does it still need to be keyed (actionable)?
//
// CURRENT STATE — passthrough:
//   Default implementation. Returns `status="unknown"` for every event.
//   Behaviour is IDENTICAL to the pre-event-level-filtering tool —
//   nothing is hidden on the basis of documentation status.
//
// UPGRADE PATH — Auror events API integration:
//   Documented in `docs/AUROR_EVENT_API_SNIFF_PLAN.md`. Once the sniff
//   lands, the call site in background.js's appriss_lookup handler
//   passes a real `documentedKeys` Set (built from a per-person events
//   API call) into classifyAll(). The classifier then flips matching
//   events to `status="documented"` and the visibility rule
//   (`actionableEventCount(suspect) > 0`) hides them at the event level
//   without ever suppressing a suspect that still has undocumented
//   events.
//
// Key shape (must match Python pipeline/event_classifier.py::EventKey):
//   `${date}|${store}|${register}|${amount}|${card_last4}`
// All five fields together identify one event. Auror's per-person events
// list will need to be normalised to the same shape before the keys are
// passed in.

import { eventIsActionable, actionableEventCount } from "./models.js";

const PASSTHROUGH_REASON =
  "Documentation status unknown — Auror events API not yet integrated";

function eventKey(ev) {
  return `${ev.date}|${ev.store}|${ev.register}|${ev.amount}|${ev.card_last4}`;
}

// Mutate each event.status / event.reason in place.
//
// suspect:            a Suspect plain object with `events` populated.
// homeStore:          the AP team's home store number. Reserved for
//                     future per-event rules that need to know whether
//                     this event is at home — currently informational.
// documentedKeys:     optional Set<string> of EventKey strings identifying
//                     events already keyed in Auror. When null/undefined,
//                     every event is marked `status="unknown"` — no
//                     filtering. Safe default until the Auror events API
//                     is wired (see module docstring).
export function classifyEvents(suspect, homeStore, documentedKeys = null) {
  if (!documentedKeys) {
    // Passthrough — no signal, no filtering, no behavior change.
    for (const ev of suspect.events ?? []) {
      ev.status = "unknown";
      ev.reason = PASSTHROUGH_REASON;
    }
    return;
  }
  const keys = documentedKeys instanceof Set
    ? documentedKeys
    : new Set(documentedKeys);
  for (const ev of suspect.events ?? []) {
    if (keys.has(eventKey(ev))) {
      ev.status = "documented";
      ev.reason = `Matched Auror event at store #${ev.store} on ${ev.date}`;
    } else {
      ev.status = "actionable";
      ev.reason = `No matching Auror event at store #${ev.store} for ${ev.date}`;
    }
  }
}

// Apply classifyEvents to every suspect; returns the list unchanged.
export function classifyAll(suspects, homeStore, documentedKeys = null) {
  for (const s of suspects ?? []) {
    classifyEvents(s, homeStore, documentedKeys);
  }
  return suspects;
}

// Drop suspects whose every event is `status="documented"`. Suspects with
// at least one actionable (or unknown) event remain visible. With the
// passthrough classifier in place, this is a no-op (every event is
// "unknown" → actionable count == event count).
export function filterToActionable(suspects) {
  return (suspects ?? []).filter(s => actionableEventCount(s) > 0);
}

export { eventIsActionable };
