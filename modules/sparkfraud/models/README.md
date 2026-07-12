# Models

Normalized evidence models. **MODEL-01 landed 2026-05-22** — normalizer factories exist and are invoked in `runSearch` for shape validation (result ignored). MODEL-02/03 will switch real consumers.

## Files

| File | Exports | Purpose |
|---|---|---|
| `index.js` | re-exports | Single import point |
| `trip.js` | `toTrip`, `computeInStoreWindow` | Normalized Dispatcher trip |
| `driver.js` | `toDriver` | Phone E.164, email lowercased |
| `order.js` | `toOrder`, `attachOmsItems` | Order; customer **redacted by default** |
| `item.js` | `toItem` | Normalized money, quantity, `isCancelled` |
| `evidence.js` | `toEvidence` | Provenance: `{sources, fetchedBy: "live"\|"replay"\|"cached"}` |

## Why

Today raw response shapes flow unchanged from network → render. `printTrip`, `renderTrips`, `tripInStoreWindow`, `fetchOrderItems` all reach deep into `t.driver.contact.phoneNumber` / `row.orderNo` / etc. Three drift risks:

1. Walmart renames a field → 3+ silent breakage sites.
2. Two response shapes use different names for the same thing (Dispatcher: `orderId`, OMS: `orderNo`).
3. Sensitive fields (customer name, address) are passed around unredacted.

## Planned models

| Model | Purpose | Source |
|---|---|---|
| `Trip` | Normalized Dispatcher trip | `app.js:fetchTrips` response |
| `Driver` | Phone E.164, email lowercased | `Trip.driver` |
| `Order` | Customer fields **redacted by default** (first-name initial only, region only) | `Trip.orders[]` + OMS rows merged |
| `Item` | Item with normalized money, quantity | OMS row |
| `EvidenceRecord` | Provenance: `{sources, fetchedBy: "live"\|"replay"\|"cached", capturedAtMs}` | every model |
| `CandidateMatch` | `Trip` + `confidence: VERIFIED\|LIKELY\|POSSIBLE\|UNKNOWN\|CONFLICTING` + rationale + ambiguity + timeline | derived |
| `InvestigationRecord` | One per search; persisted to `chrome.storage.local.investigations` | `runSearch` |

## Adoption sequence (per `docs/TASKS.md` MODEL-*)

1. MODEL-01 — Add `to<Model>(raw)` pure functions. Call but ignore the result. Validates shape.
2. MODEL-02 — `printTrip` consumes `Trip`.
3. MODEL-03 — `renderTrips` + `renderItemsForTrip` consume.
4. CANDIDATE-01 — Introduce `CandidateMatch` + confidence rendering.
5. JOURNAL-01 — Persist `InvestigationRecord`.

## Confidence labeling (binding once CANDIDATE-01 ships)

Charter rule: never present inferred correlations as verified facts. Initial heuristic mapping (subject to Shane's sign-off):

- Event time inside `[PICKED, DISPATCHED]` window ≥ 4 min → **LIKELY**
- Event time inside ≤ 2 min window or boundary match → **POSSIBLE**
- Missing `taskEvents` → **UNKNOWN** (do NOT infer from customer window alone)
- Multiple trips overlap event time, no distinguisher → **CONFLICTING**
- Direct order ID lookup → **VERIFIED**

## Data safety

- `Order.unredact()` accessor for full customer data — emits a `redaction.expanded` telemetry event when called.
- Models default to redacted serialization (`toJSON`).
- Models NEVER serialize cookie/header values.
