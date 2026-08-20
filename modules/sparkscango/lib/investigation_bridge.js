// modules/sparkscango/lib/investigation_bridge.js
//
// Given an ExceptionRow, decide the strongest available lookup and hand
// back a typed result the drawer can render. Reuses the shared spark
// investigation service, so behavior stays in lock-step with SparkFraud.
//
// Strategy order (matches SparkFraud's manual quick-lookup priority):
//   1. Order ID     → OMS drive + Dispatcher trip resolution
//   2. Trip ID      → Dispatcher direct-lookup (best-effort)
//   3. Driver ID    → Dispatcher name search (ID treated as name token)
//   4. Driver name  → Dispatcher name search
//   5. Store + time → Dispatcher window query, no name filter (broad)
//   6. Nothing usable → returns { strategy: "none", reason }
//
// Scan & Go rows almost never carry Spark identifiers. When called on a
// Scan&Go row with no order/trip/driver, this returns strategy="none" with
// a reason string — the drawer then renders source-only.

import { extractIdentifiers } from "./models.js";
import { detectQueryType } from "../../../shared/sparkInvestigation/input_detect.js";

export const STRATEGY = Object.freeze({
  NONE:         "none",
  ORDER:        "order",
  TRIP:         "trip",
  DRIVER_ID:    "driver-id",
  DRIVER_NAME:  "driver-name",
  STORE_WINDOW: "store-window",
});

/**
 * Decide which lookup to run. Pure — does no I/O. Called from view.js at
 * row-click to preview the strategy before firing the actual SW handlers.
 *
 * @param {import("./models.js").ExceptionRow} row
 * @returns {{ strategy: string, ids: object, reason?: string }}
 */
export function pickStrategy(row) {
  const ids = extractIdentifiers(row);
  if (ids.orderId)                              return { strategy: STRATEGY.ORDER, ids };
  if (ids.tripId)                               return { strategy: STRATEGY.TRIP, ids };
  if (ids.driverId)                             return { strategy: STRATEGY.DRIVER_ID, ids };
  if (ids.driverName)                           return { strategy: STRATEGY.DRIVER_NAME, ids };
  if (ids.storeNbr && ids.eventTsMs != null)    return { strategy: STRATEGY.STORE_WINDOW, ids };
  return {
    strategy: STRATEGY.NONE,
    ids,
    reason: row.source === "scango"
      ? "Scan & Go rows typically lack Spark identifiers. Investigation drawer will show source-only detail."
      : "Source row has no order, trip, driver, or store+time identifier. Broaden the search inputs to try again.",
  };
}

/**
 * Free-text broaden — user typed into the drawer's "Broaden search" input.
 * Reuses shared/sparkInvestigation/input_detect so behavior matches
 * SparkFraud's quick-lookup input handling exactly.
 */
export function classifyBroadenInput(text) {
  return detectQueryType(text);
}

/**
 * Fire the actual lookup. The `host` argument is the view's shell host —
 * used to `host.messaging.send()` into the SW handlers.
 *
 * Adapter is intentionally thin: the SW does the heavy lifting via
 * pull_sparkscango_investigate. This function normalizes the response into
 * a typed shape the drawer can render without knowing which SW handler ran.
 */
export async function runInvestigation(host, row, override) {
  const decision = override
    ? { strategy: override.strategy, ids: { ...extractIdentifiers(row), ...override.ids } }
    : pickStrategy(row);

  if (decision.strategy === STRATEGY.NONE) {
    return {
      ok: false,
      strategy: decision.strategy,
      reason: decision.reason || "No usable identifier.",
      candidates: [],
    };
  }

  const resp = await host.messaging.send("investigate", {
    strategy: decision.strategy,
    ids:      decision.ids,
    source:   row.source,
  }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

  return {
    ok:         !!resp?.ok,
    strategy:   decision.strategy,
    ids:        decision.ids,
    candidates: Array.isArray(resp?.candidates) ? resp.candidates : [],
    reason:     resp?.reason || (resp?.ok ? null : (resp?.error || "Lookup returned no data.")),
    sourceFacts:   toSourceFacts(row),
    matchedFacts:  resp?.matchedFacts || null,
    inferences:    resp?.inferences || null,
  };
}

function toSourceFacts(row) {
  // Return only fields with values — the drawer renders a labeled list.
  const facts = {};
  const push = (k, v) => { if (v != null && v !== "") facts[k] = v; };
  push("Exception ID",   row.exceptionId);
  push("Exception type", row.exceptionType);
  push("Store",          row.storeNbr);
  push("Market",         row.marketNbr);
  push("Region",         row.regionNbr);
  push("Order ID",       row.orderId);
  push("Trip ID",        row.tripId);
  push("Driver",         row.driverName || row.driverId);
  push("Transaction",    row.transactionId);
  push("Receipt",        row.receiptId);
  push("Register",       row.registerNbr);
  push("Shopper",        row.shopperId);
  push("Source status",  row.sourceStatus);
  if (row.eventTimestamp) {
    facts["Event time"] = new Date(row.eventTimestamp).toISOString();
  }
  return facts;
}
