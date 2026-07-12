# Telemetry

Structured event ring buffer for SparkFraud. **Active as of 2026-05-22 (TELEMETRY-01); race-fixed + expanded TELEMETRY-02.** No dev panel yet (TELEMETRY-03).

## Architecture (TELEMETRY-02)

`emit()` is **synchronous** — appends the event to an in-memory queue and schedules a debounced flush (250ms). The flush drains the queue, merges with the storage ring buffer, and writes once. Bursts of emits collapse into a single storage write. **No two flushes run concurrently** — the previous read-modify-write race that dropped events when multiple emits fired in quick succession is fixed.

If a flush fails, the batch is re-queued at the head and retried on the next flush. Lossy only if the page closes mid-debounce — acceptable for observability.

## Usage

Import + emit (synchronous, fire-and-forget):

```js
import { emit, EVENTS } from "./telemetry/events.js";
emit(EVENTS.SEARCH_STARTED, { store: "9999", windowMin: 30, /* ... */ });
```

Inspect from DevTools console:

```js
// Awaited snapshot (flushes pending queue first — freshest possible)
import("./telemetry/events.js").then(m => m.readTelemetry().then(t => console.table(t.slice(-30))));

// Raw storage read (may miss in-flight events)
chrome.storage.local.get('telemetry').then(r => console.table(r.telemetry.slice(-30)))
```

Clear:

```js
import { clearTelemetry } from "./telemetry/events.js";
await clearTelemetry();
```

## Active emit sites

All in `extension/app.js`:

| Event | Where | Payload |
|---|---|---|
| `search.started` | `runSearch` after services validation | `{store, windowMin, services[], serviceTypes[], lookupMode, replay}` |
| `search.dispatcher.request` *(NEW)* | `runSearch` before `fetchTrips` | `{startTime, endTime, windowMin, services[], serviceTypes[], replay}` |
| `search.dispatcher.completed` | `fetchTrips` success | `{durationMs, trips}` |
| `search.dispatcher.failed` | `fetchTrips` throw | `{durationMs, error}` |
| `search.viability.computed` *(NEW)* | `renderTrips` after viability filter | `{totalCompleted, viable, dropped, hasTaskEventsCount, noTaskEventsCount, lookupMode}` |
| `search.oms.completed` | `fetchOrderItems` success | `{durationMs, orderCount, rowCount}` |
| `search.oms.failed` | `fetchOrderItems` throw | `{durationMs, error}` |
| `search.completed` | `runSearch` finally | `{durationMs, success}` |
| `lookup.started` *(NEW)* | `runOrderLookup` after parse | `{orderCount, hadCachedHeaders}` |
| `lookup.completed` *(NEW)* | `runOrderLookup` finally | `{durationMs, orderCount, success}` |
| `confidence.assigned` | per candidate in `renderTrips` | `{confidence, metrics, rationaleCount, ambiguityCount, replay}` |
| `redaction.expanded` | `printTrip` | `{context, scope, orderCount}` |
| `replay.loaded` | `loadDispatcherFixture` | `{fixtureName}` |

## Why each NEW event matters

- **`search.dispatcher.request`** — captures the EXACT outgoing time window. The TZ shift bug fixed 2026-05-22 (where evening searches were silently queried as overnight) would have been visible in telemetry on the first run if this event had existed. Now it does.
- **`search.viability.computed`** — `hasTaskEventsCount` is the canary for `taskEventStatuses` rename drift (HIGH risk per `enums.json`). If `hasTaskEventsCount` suddenly drops to 0, PICKED/DISPATCHED were probably renamed and viability filter is silently failing.
- **`lookup.*`** — lookup-mode investigations were invisible in telemetry pre-TELEMETRY-02. Now searches and lookups both have full lifecycle visibility.

## Deferred to TELEMETRY-03 (or later)

- Dev panel UI in `app.html` header
- `background.js` emit sites: `auth.cookies.read`, `search.oms.staleHeaders`, `capture.bufferPressure`, `thumbnail.lookup`, `selector.missed`
- Cross-context queue (currently the SW has its own queue; events emitted in SW vs page aren't combined)

## Mandatory payload schema rules

- **Counts, durations, statuses, booleans, error class names only.**
- NO cookie values, NO header values, NO `authToken` / `authHeader`.
- NO driver names, emails, phones. NO customer names, addresses. NO order IDs.
- Sanitized snippets allowed (already truncated to 300 chars at `background.js:472`).

The `events.js` `sanitize()` function strips keys matching `/authtoken|authheader|cookie|password|secret|phonenumber|firstname|lastname|email|address|orderid|orderno|driveruuid|driveruserid/i` as belt-and-suspenders — primary protection is still caller payload discipline.

## Storage

`chrome.storage.local["telemetry"]` — bounded ring buffer of 500 events. NEVER ships to external endpoints. Survives extension reload. Cleared on Edge profile reset or by `clearTelemetry()`.
