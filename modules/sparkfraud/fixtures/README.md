# Fixtures

Replay fixtures for offline development, regression checks, and autonomous workflows. **Dispatcher replay live as of 2026-05-22 (REPLAY-01).** OMS fixture support deferred to REPLAY-02.

## Active fixtures

See [`fixtures_index.json`](fixtures_index.json) for the catalog.

| Name | Files | Scenario |
|---|---|---|
| `morning_rush` | `dispatcher_morning_rush.json` | 3 trips on synthetic 2026-05-07, store 9999. Exercises viable on-time, viable delayed, and in-window-but-not-viable cases. |

## Usage

```
chrome-extension://<id>/app.html?replay=morning_rush
```

Then set the Date input to the fixture's `synthetic_date` (e.g., `2026-05-07` for `morning_rush`) and click **Find candidates** with the defaults (`08:40`, ±30min, dt-spark + dt-express checked). The console will log:

```
[SparkFraud] REPLAY: loaded fixture dispatcher_morning_rush.json
[SparkFraud] REPLAY: skipping OMS call (oms fixture support pending REPLAY-02)
```

In replay mode trips render WITHOUT items ("No item details returned for this trip's orders.") until REPLAY-02 lands.

## Purpose

Today every UI iteration needs Edge + SSO + a live trip + a live OMS query. Fixtures unblock:

- UI development without SSO
- Regression checks against known-good responses
- Investigation reproduction (rerun a past case offline)
- Autonomous analysis workflows

## Planned consumers

- `?replay=<name>` query param on `app.html` → `app.js:fetchTrips` reads `fixtures/dispatcher_<name>.json` instead of calling swift.
- `?replay=<name>` → `app.js:fetchOrderItems` reads `fixtures/oms_<name>.json` instead of driving Order Resolution.
- `?record=1` → live response is staged in `chrome.storage.local.lastCapture` for the developer to sanitize and save here.

## Naming convention

```
dispatcher_<scenario>.json   — Dispatcher /v4/dashboard response
oms_<scenario>.json          — OMS /provider-oms/orders response

Example scenarios:
  dispatcher_morning_rush.json
  dispatcher_empty_window.json
  dispatcher_delayed_trip.json
  oms_single_order_18_items.json
  oms_9_orders_162_rows.json
  oms_cancelled_lines.json
```

## Data safety (mandatory)

**Committed fixtures MUST be fully synthetic.** Sanitization scheme (deterministic so cross-fixture references work):

| Real field | Replacement |
|---|---|
| `driverUserId` (email) | `driver_001@synthetic.local` |
| `driverUuid` | `00000000-0000-0000-0000-000000000001` |
| `firstName` / `lastName` / `preferredName` | `Driver` / `One` / `D1` |
| `contact.phoneNumber` | `+15555550001` |
| `orderId` | `200099900000001` (last 7 digits = sequence) |
| `customerFirstName` | `Customer1` |
| `customerEmail` | `customer1@synthetic.local` |
| `shipToAddress` / `city` / `state` / `postalCode` | `123 Synthetic St` / `Testtown` / `XX` / `00001` |

Preserve structural shape, item-count distribution, line-status mix, and `taskEvents` timing (those drive viability). All other fields may be replaced or zeroed.

**Redacted-real fixtures**, if anyone needs them, live outside the repo at `%LOCALAPPDATA%/SparkFraud/fixtures/` and are loaded by an external path config — never committed.

## Fixture index

Once REPLAY-01 lands, an `fixtures_index.json` will catalog each fixture with `{name, sourceEndpoint, capturedAtMs, sanitized: bool, syntheticIds: bool}`.

## Source material on disk (not yet fixtures)

The repo currently contains raw captured responses that are *candidates* for fixtures pending sanitization:

| File | Endpoint | Size | Status |
|---|---|---|---|
| `dispatcher_today_v2.json` | dispatcher_trips | 1315 lines | NOT sanitized — do not promote as-is |
| `orders_response.json` | oms_orders | 14029 lines | NOT sanitized |
| `investigate_results/oms_response_0.json` | oms_orders | ? | NOT sanitized |
| `investigate_results/timeline.json` | unknown | ? | NOT sanitized |

These will be sanitized and promoted (or discarded) during REPLAY-01.
