# AurorBuddy Usage Metrics Model

Per-action telemetry — separate from the per-workflow lifecycle records. Goal: answer questions today's data can't, like "what % of imports drop off at the APPRISS-lookup step?" or "which stores are using the tool weekly?"

Implemented as `modules/aurorbuddy/lib/usage_metrics.js` in the suite (and consumable by other modules via the same helper).

---

## 1. The collection

`/tool_metric_events/{autoId}` — append-only, append-on-action telemetry. One row per discrete user-visible action or completion event. Read by the dashboard for funnels, by analysts (themselves) for self-debugging.

```ts
type MetricEvent = {
  metricId:          string;            // autoId
  timestamp:         Timestamp;         // serverTimestamp on create

  // Identity (common header from BACKEND_DATA_MODEL.md §4)
  analystUid:        string;
  analystSource:     "shanesmith" | "suite";
  aurorUserName:     string;
  aurorUserEmail:    string;
  storeNumber:       string;
  toolVersion:       string;

  // Cross-ref
  workflowId:        string | null;    // null if the action is workflow-independent (e.g. "module_opened")

  // The action
  moduleName:        string;           // "aurorbuddy", "licenseintake", "sparkfraud", etc.
  actionName:        string;           // see §3
  result:            "success" | "failure" | "canceled" | "pending";
  durationMs:        number | null;    // null if not measurable / not a duration-bearing action

  // Context (minimal — operational metadata only, no PII beyond what's already in identity header)
  browser:           string;           // navigator.userAgent slug — "Edge/124", "Chrome/124"
  contextHint:       string | null;    // tiny free-text context — e.g. "store=1458,suspects=12". MUST NOT contain card numbers, license fields, DOB, addresses, tokens, full names beyond the analyst's own.

  // Failure context
  errorCode:         string | null;    // machine-parseable e.g. "appriss_lookup_500"
  errorMessageRedacted: string | null; // human-readable, redacted per §5
}
```

---

## 2. Helper API

`modules/aurorbuddy/lib/usage_metrics.js` exports:

```ts
recordMetric({ moduleName, actionName, result, durationMs?, workflowId?, contextHint?, errorCode?, errorMessageRedacted? }) → Promise<void>
recordWorkflowStatus(workflowId, status, patch?) → Promise<void>   // delegates to workflow_status.js, also emits a "workflow_status_changed" metric event
recordError(moduleName, actionName, errorCode, redactedMessage) → Promise<void>  // sugar wrapper that sets result: "failure"
flushQueuedMetrics() → Promise<{ drained: number, remaining: number }>
retryFailedMetrics() → Promise<void>   // ≡ flushQueuedMetrics; alias for symmetry with the prompt's API
```

Other modules (LicenseIntake, SparkBuddy, etc.) consume the same helper by importing from `unified-extension-suite/shared/usage_metrics.js` — a re-export of the AurorBuddy implementation as a shared helper once a second module adopts it (matches the `shared/http.js` 2nd-consumer rule per `README.md::Shared helper inventory`).

**Best-effort guarantees:**
- Metrics write failure NEVER throws into the caller's promise chain. Internal try/catch only.
- Metrics write failure NEVER blocks a user-visible workflow. If Firestore is down, scan still runs, save still works, the user never knows.
- All failures enqueue to `chrome.storage.local["aurorbuddy.fb_pendingMetrics"]` (separate from the firestore writer's `fb_pendingWrites` queue so a write storm in one doesn't stall the other).
- Retry alarm `aurorbuddy-fb-metrics-flush` fires every 5 min until queue empty (same pattern as firestore.js).
- Queue capped at 1000 entries; oldest dropped on overflow (telemetry shouldn't grow unbounded).

---

## 3. Action vocabulary (initial set)

Stable strings. Add new ones freely; deprecate by adding `_v2` rather than renaming (existing dashboard queries break otherwise). All modules should match this casing convention.

### AurorBuddy
- `module_opened` — user navigated to the AurorBuddy module
- `search_auror_person`
- `appriss_lookup` (durationMs from request → response)
- `scan_completed` (durationMs from start → results rendered)
- `import_to_auror_start` (also emits `recordWorkflowStatus(import_started)`)
- `import_to_auror_prefilled` (with `recordWorkflowStatus(import_prefilled)`)
- `stage_person_draft`
- `submit_detected` (with `recordWorkflowStatus(submitted_detected)`)
- `final_value_captured` (with `recordWorkflowStatus(final_value_captured)`)
- `evidence_download_start`
- `evidence_download_complete`
- `workflow_canceled`
- `workflow_failed`
- `mark_submitted_clicked` (V1 final-value-capture UX)

### LicenseIntake
- `module_opened`
- `scan_license`
- `parse_license`
- `aamva_parse_failed`

### SparkBuddy
- `module_opened`
- `register_event_pulled`
- `spark_trip_correlated`

### Cross-module
- `module_opened` (every module emits this; common surface for "MAU by module")
- `metrics_flush_attempted` (rare; only on flush completion summary)

---

## 4. Per-analyst rollups (recap)

Per-action events do NOT directly bump `/tool_metrics/{uid}`. That collection is the slow-changing summary; per-action events are the firehose. The dashboard can do its own client-side rollups by querying `tool_metric_events` with date filters, or a scheduled Cloud Function (deferred) can write rollups into `/tool_metrics`.

For the corrected workflow counts (`workflowsStarted`, `workflowsCompleted`, etc. per `BACKEND_DATA_MODEL.md §E`), `transitionWorkflow()` in `workflow_status.js` bumps those counters atomically via Firestore increment transforms — those don't go through the metric-events queue.

---

## 5. PII redaction rules

The CRITICAL rule from the user's prompt: *"Do not store unnecessary PII. Do not log full card numbers, license data, DOB, addresses, tokens, cookies, or sensitive auth data."*

Concrete:

- `contextHint` is a `<= 200 char` string. The helper truncates and strips on write.
- A regex blocklist applied to `contextHint` and `errorMessageRedacted` before write:
  - Card-like 13–19 digit runs → `<card-redacted>`
  - 9-digit runs (potential SSN) → `<id-redacted>`
  - `Bearer\s+[A-Za-z0-9._-]+` → `Bearer <token-redacted>`
  - `(password|token|secret|cookie|jwt|api[_-]?key)\s*[:=]\s*\S+` → `$1: <redacted>`
- Email addresses other than `aurorUserEmail` (the analyst's own) → `<email-redacted>`. Catches "found suspect [name]@gmail.com" type leakage.
- Suspect names are NOT redacted from the `suspectName` field on workflow/event records (we need them for the dashboard) but DO NOT appear in metric event contextHints — call sites must not include them.
- License-scan content from LicenseIntake (AAMVA fields like DAQ, DBB, DAG) never go into metric events — only the action name + result.
- APPRISS raw response bodies never go into `errorMessageRedacted`. Use error codes instead.

The helper enforces these via a `sanitizeForMetric()` pass on all string-typed fields. If a caller passes a value the sanitizer would block, the value is replaced and a one-time `console.warn` fires in dev (not in prod).

---

## 6. Volume estimate

Per the existing audit, 20-analyst team, 20 scans/day each. Per scan we expect ~5–10 metric events end-to-end (open → search → appriss → import → submit → capture). Generous estimate:

- 20 × 20 × 10 = 4,000 metric events/day → ~120K/month.
- Firestore Spark plan: 20K writes/day = 600K/month. We'd be at 20% of the free-tier writes ceiling.

If the team grows past 50 analysts the budget gets tight. At that point either move to Blaze (~$3/month at this volume) or downsample to milestone events only (drop `module_opened`, keep workflow transitions). Both are reversible.

---

## 7. Dashboard queries (informational)

These are the queries the dashboard will issue to power the new tiles, listed so anyone touching `dashboard/app.js` can reason about the indexes needed.

```
// MAU by module
collection('tool_metric_events')
  .where('actionName', '==', 'module_opened')
  .where('timestamp', '>=', last_30_days)
  // group client-side by analystUid + moduleName

// Funnel drop-off
collection('tool_metric_events')
  .where('actionName', 'in', ['import_to_auror_start', 'import_to_auror_prefilled',
                              'submit_detected', 'final_value_captured'])
  .where('timestamp', '>=', last_30_days)
  // group client-side by actionName, count distinct workflowId

// Store usage
collection('tool_metric_events')
  .where('actionName', '==', 'scan_completed')
  .where('timestamp', '>=', last_30_days)
  // group client-side by storeNumber, count

// Error rate
collection('tool_metric_events')
  .where('result', '==', 'failure')
  .where('timestamp', '>=', last_7_days)
  // group client-side by errorCode, count
```

Composite indexes needed:
- `(actionName, timestamp DESC)`
- `(result, timestamp DESC)`

Add these to `firestore.indexes.json` when Phase 2 lands.

---

## 8. Export helper

For the user's "tools/export_usage_metrics_report.js" deliverable: lives in the suite at `unified-extension-suite/tools/export_usage_metrics_report.mjs` (Node, run with the Firebase Admin SDK). Emits CSV + JSON to stdout with:

- Store usage totals (column: storeNumber, scansLast30Days, eventsLast30Days, distinctAnalysts)
- User usage totals (column: aurorUserEmail, scansLast30Days, eventsLast30Days, lastSeen)
- Module usage totals (column: moduleName, opensLast30Days, distinctUsers)
- Workflow status counts (column: status, count)
- Legacy-value warnings — count of `tool_events` rows where `valueDisplayLabel === "Legacy proxy (suspectTotalValue)"`

Run requires `GOOGLE_APPLICATION_CREDENTIALS` env var pointing at a Firebase Admin service-account key. Not part of the extension; not shipped to users; runs from the developer's laptop on demand.
