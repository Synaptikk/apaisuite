# Registries

Machine-readable canonical knowledge for SparkFraud. Each file in this directory is **load-bearing operational cognition**, not passive documentation.

## Rule

If a fact lives in `app.js` AND `background.js` AND a recon script AND `notes/`, that fact belongs here. Runtime code reads the registry; everyone else references it.

## Files

| File | Owns | Consumed by (current / planned) |
|---|---|---|
| [`enums.json`](enums.json) | `services`, `serviceTypes`, `tripDisplayStatuses`, `transitStatuses`, `carriers`, `lineStatuses`, `taskEventStatuses`, `orderTypes`, `roles`, UI checkbox → API mapping | **`app.js` `DELIVERY_TYPE_ITEMS`** (load-bearing as of 2026-05-22) |
| [`selectors.json`](selectors.json) | Fragile DOM selectors driving the gscope/swift SPA + environmental hazards (Postman Interceptor ID, edge://extensions/ behavior) + React controlled-input pattern | planned: `background.js` selectors |
| [`auth_modes.json`](auth_modes.json) | Per-origin auth strategies, header sets, cookie keys, strip lists, data safety rules | planned: `app.js:buildHeaders`, `background.js:driveOrderResolution`, `recon/_auth.py` |
| [`endpoints.json`](endpoints.json) | Every internal endpoint we touch or have documented + the SPA-router-fallback do-not-call list | planned: `app.js`, `background.js`, recon |
| [`store_config.json`](store_config.json) | Per-store TZ, label, default roles, current investigator metadata | planned: `app.js` TZ + store fallback |
| [`realmids.json`](realmids.json) | `x-realmid` value per endpoint group; UNKNOWNs flagged with drift risk | planned: `auth_modes.json` consumers |

## Format conventions

- Every registry has a `_meta` block with: `purpose`, `seeded_from`, `seeded_on`, `regenerable_via` (when applicable).
- Every fact carries a `confidence` label: `VERIFIED` / `LIKELY` / `POSSIBLE` / `UNKNOWN` / `CONFLICTING`.
- Enum lists carry `exhaustive: true | false` so consumers know whether to fail-closed or fail-open on unknown values.
- `drift_risk` field (`LOW` / `MEDIUM` / `HIGH`) on selectors and enums where the upstream is known to mutate.

## Maintenance

- **Change a registry first**, then the consumer. Never the other way around.
- When you discover a new fact (new enum value, new endpoint, new selector breakage): update the registry, then log it in `docs/DISCOVERIES.md`.
- When recon probes a value that's already in a registry, compare and update the `last_verified` field. If values diverge, file a drift discovery.
- Treat registries as code — review changes carefully. A wrong `enums.json` entry can mis-route every search.

## Data safety

- No cookie VALUES in any registry.
- No `authToken` / `authHeader` values, EVER.
- No PII (driver names, customer names, phone numbers).
- Examples and placeholders only — use `<cookie 'foo'>` notation.
