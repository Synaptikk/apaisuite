// lib/models.js — typed Suspect / Event domain (extension side)
// ────────────────────────────────────────────────────────────────────────────
// JS port of pipeline/models.py. The unit of investigation is the EVENT
// (one APPRISS transaction at the home store or — under AurorBuddy's
// "show cross-store activity" policy — at a neighbouring store flagged
// with at_home=false). A suspect has many events, optionally grouped by
// the payment card used. Filtering decisions are made at the event level
// — see lib/event_classifier.js.
//
// JS plain objects, not class instances, so they round-trip cleanly
// through chrome.runtime.sendMessage's structured clone and through any
// future Firestore-style JSON wire format without per-field serialisation
// helpers.
//
// Backward compatibility:
//   suspectToWire() emits BOTH the new flat `events` list AND the legacy
//   `appriss_cards: [{ name, last4, card_masked, transactions: [...] }]`
//   shape that the current app.js iterates. Same backing data, two views.
//   Once renderApprissHtml() iterates `events` directly, the legacy view
//   can be dropped.
//
// Status enum (matches pipeline/event_classifier.py):
//   "actionable"        — needs to be keyed in Auror
//   "likely_documented" — heuristic match, low confidence
//   "documented"        — confirmed Auror event already exists
//   "unknown"           — classifier hasn't run, or the Auror events API
//                         isn't wired yet (passthrough default)

// ─── Event ──────────────────────────────────────────────────────────────────

// Build one Event from a legacy transaction dict (the shape lib/appriss.js
// returns) + its parent card metadata. Status starts at "unknown"; the
// classifier may overwrite.
function eventFromTxn(t, { card_last4, card_name, card_masked }) {
  const dt = String(t?.datetime ?? "");
  return {
    transaction_id: t?.transaction_id ?? "",
    date:           dateFromDatetime(dt),
    datetime:       dt,
    store:          t?.store ?? "",
    register:       t?.register ?? "",
    cashier:        t?.cashier ?? "",
    trans_no:       t?.trans_no ?? "",
    amount:         t?.amount ?? "",
    cardholder:     t?.cardholder ?? "",
    card_last4,
    card_name,
    card_masked,
    at_home:        !!t?.at_home,
    cctv_url:       t?.cctv_url ?? null,
    receipt_url:    t?.receipt_url ?? null,
    status:         "unknown",
    reason:         "Documentation status unknown — Auror events API not yet integrated",
  };
}

// "An event is actionable if it is not confirmed documented in Auror."
// Same rule as pipeline/models.py::Event.actionable.
export function eventIsActionable(ev) {
  return ev?.status !== "documented";
}

function dateFromDatetime(dt) {
  if (!dt) return "";
  return dt.split(" ", 1)[0] ?? "";
}

// Emit the legacy transaction shape the existing UI iterates. New
// event-level fields piggyback for any UI that wants them.
function eventToLegacyTxn(ev) {
  return {
    store:          ev.store,
    cashier:        ev.cashier,
    register:       ev.register,
    trans_no:       ev.trans_no,
    amount:         ev.amount,
    datetime:       ev.datetime,
    cardholder:     ev.cardholder,
    transaction_id: ev.transaction_id,
    cctv_url:       ev.cctv_url,
    receipt_url:    ev.receipt_url,
    at_home:        ev.at_home,
    status:         ev.status,
    reason:         ev.reason,
    actionable:     eventIsActionable(ev),
  };
}

// ─── Suspect ────────────────────────────────────────────────────────────────

// Convert one scraper-produced suspect dict (the shape lib/appriss.js
// returns after the cross-reference completes) into an internal Suspect
// object with an `events` array. `_raw_cards` is preserved so the legacy
// appriss_cards view in suspectToWire() can reconstruct itself with no
// loss — including cards that came back with zero events.
export function suspectFromRaw(raw) {
  const cards = raw?.appriss_cards ?? [];
  const events = [];
  for (const card of cards) {
    const card_last4  = card?.last4 ?? "";
    const card_name   = card?.name ?? "";
    const card_masked = card?.card_masked ?? "";
    for (const t of card?.transactions ?? []) {
      events.push(eventFromTxn(t, { card_last4, card_name, card_masked }));
    }
  }
  return {
    person_id:         raw?.person_id ?? "",
    name:              raw?.name ?? "",
    first_name:        raw?.first_name ?? "",
    last_name:         raw?.last_name ?? "",
    photo_url:         raw?.photo_url ?? "",
    auror_url:         raw?.auror_url ?? "",
    event_count:       Number(raw?.event_count ?? 0),
    total_value:       Number(raw?.total_value ?? 0),
    is_orc:            !!raw?.is_orc,
    threatening:       !!raw?.threatening,
    threatening_types: Array.isArray(raw?.threatening_types) ? [...raw.threatening_types] : [],
    appriss_status:    raw?.appriss_status ?? "unknown",
    appriss_error:     raw?.appriss_error ?? null,
    events,
    _raw_cards:        [...cards],
  };
}

export function suspectsFromRaws(raws) {
  return (raws ?? []).map(suspectFromRaw);
}

// Count of events that are not confirmed documented. The visibility rule
// the classifier eventually enforces is `actionable_event_count > 0`.
export function actionableEventCount(suspect) {
  return (suspect?.events ?? []).filter(eventIsActionable).length;
}

// Emit both the new `events` view AND the legacy `appriss_cards` view.
// The UI today iterates `appriss_cards[].transactions[]`. Once it
// switches to iterating `events` directly, `_raw_cards` can be dropped
// from this output and `appriss_cards` removed.
export function suspectToWire(suspect) {
  // Group events back into cards for the legacy view, keyed by
  // last4|cardholder name (matches pipeline/models.py keying).
  const cardsByKey = new Map();
  for (const ev of suspect.events ?? []) {
    const key = `${ev.card_last4}|${ev.card_name}`;
    let card = cardsByKey.get(key);
    if (!card) {
      card = {
        name:         ev.card_name,
        last4:        ev.card_last4,
        card_masked:  ev.card_masked,
        transactions: [],
      };
      cardsByKey.set(key, card);
    }
    card.transactions.push(eventToLegacyTxn(ev));
  }

  // Preserve original card ordering + any cards that had zero events.
  const legacy = [];
  const seen = new Set();
  for (const raw of suspect._raw_cards ?? []) {
    const key = `${raw?.last4 ?? ""}|${raw?.name ?? ""}`;
    seen.add(key);
    if (cardsByKey.has(key)) {
      legacy.push(cardsByKey.get(key));
    } else {
      legacy.push({
        name:         raw?.name ?? "",
        last4:        raw?.last4 ?? "",
        card_masked:  raw?.card_masked ?? "",
        transactions: [],
      });
    }
  }
  // Cards present in events but not in _raw_cards (shouldn't happen, safe)
  for (const [key, card] of cardsByKey) {
    if (!seen.has(key)) legacy.push(card);
  }

  return {
    person_id:              suspect.person_id,
    name:                   suspect.name,
    first_name:             suspect.first_name,
    last_name:              suspect.last_name,
    photo_url:              suspect.photo_url,
    auror_url:              suspect.auror_url,
    event_count:            suspect.event_count,
    total_value:            suspect.total_value,
    is_orc:                 suspect.is_orc,
    threatening:            suspect.threatening,
    threatening_types:      [...(suspect.threatening_types ?? [])],
    appriss_status:         suspect.appriss_status,
    appriss_error:          suspect.appriss_error,
    // New event-level shape
    events:                 (suspect.events ?? []).map(eventToLegacyTxn),
    actionable_event_count: actionableEventCount(suspect),
    // Legacy card-level shape — UI continues to render from this
    appriss_cards:          legacy,
  };
}
