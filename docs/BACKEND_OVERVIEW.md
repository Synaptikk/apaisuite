# AurorBuddy Backend — Overview

The one-page guide to the AurorBuddy telemetry/case-tracking backend. Read this first for orientation; the six per-phase docs below have the depth.

**Last shipped:** 2026-06-07 (rules + indexes + dashboard deployed; suite-side writer staged)
**Live URLs:** dashboard at `https://aurorbuddy.firebaseapp.com`, Firestore in project `aurorbuddy`

---

## TL;DR

AurorBuddy's backend is a Firebase project that captures (a) per-workflow lifecycle records, (b) per-event case data, (c) per-action telemetry, and (d) per-analyst rollups. The data model deliberately separates **the APPRISS tender total** (a proxy / candidate, never the case value) from **the analyst-confirmed final event value** (the only number the dashboard's "$ confirmed" tile sums).

Two extensions write to the same Firebase project during the migration window: the legacy shanesmith extension (still distributed at `aurorbuddy.firebaseapp.com/extension/aurorbuddy.zip`) and the new unified-suite AurorBuddy module. The dashboard reads both shapes and labels them per `analystSource`.

---

## Architecture

```
  Edge tab (suite app.html)              Edge tab (Auror page)
      │                                       │
      │ user clicks Search / Mark Submitted   │
      ▼                                       │
  Suite SW (background/service_worker.js)     │
      │                                       │
      │ static-imports modules/aurorbuddy/    │ secure_pill.js content
      │   service.js  (handlers)              │ script injects "Secure"
      │   module.js   (alarms wired)          │ pill → SW message
      │                                       │
      │ via lib/firestore.js (REST, anon UID)
      ▼
  https://firestore.googleapis.com/v1/...
      │
      ├── /tool_workflows/{workflowId}     ← created at import, lifecycle tracked
      ├── /tool_events/{aurorEventId}      ← created when filler completes; final value PATCHed later
      ├── /tool_metric_events/{autoId}     ← per-action telemetry (append-only)
      ├── /tool_metrics/{uid}              ← per-analyst rollups (increment transforms)
      ├── /tool_scans/{autoId}             ← scan-completion log (legacy + suite)
      ├── /tool_cache_stores/{key}         ← find_stores cache (7d TTL)
      └── /tool_cache_scans/{key}          ← whole-scan cache (30d TTL)
                                                          ▲
                                                          │ onSnapshot
                                                          │
                                            Dashboard at aurorbuddy.firebaseapp.com
                                            (shanesmith/dashboard/app.js)
```

**No Firebase JS SDK in the extension** — REST-only against Firestore + Identity Toolkit + Secure Token endpoints. Saves ~200 KB and sidesteps MV3 SW idle-sleep issues with the SDK's WebSocket assumptions.

**Auth model:**
- Extension: Firebase Anonymous. UID stable per install. Identity stamped on every row from the captured Auror JWT (name / email / aurorUserId) — not used for auth itself.
- Dashboard: Firebase email/password. `isPasswordUser()` gates reads on `tool_scans` + `tool_metrics` + `tool_metric_events`.

---

## Live components

### Firebase project: `aurorbuddy` (project number 592946265453)

| Resource | Path / Identity |
|---|---|
| Web apiKey (public) | `AIzaSyBVbIuRW8qSXS_CVhpkKGlwrt-AFWTrWnw` |
| Hosting | `aurorbuddy.firebaseapp.com` / `aurorbuddy.web.app` — serves `~/shanesmith/dashboard/` |
| Rules source | `~/shanesmith/firestore.rules` |
| Indexes source | `~/shanesmith/firestore.indexes.json` |
| Deploy from | `~/shanesmith/` (firebase.json) |

### Suite-side writer (canonical going forward)

Lives in `unified-extension-suite/modules/aurorbuddy/`:

| File | Role |
|---|---|
| `lib/firestore_config.js` | Firebase project ID + apiKey + `ANALYST_SOURCE = "suite"` |
| `lib/firestore.js` | REST writer — `writeScan`, `createWorkflow`, `updateWorkflow`, `writeEvent`, `writeFinalEventValue`, `fetchAwaitingFinalValue`, `fetchAwaitingExpiredWorkflows` + retry queue + kill switch |
| `lib/workflow_status.js` | State machine — `startWorkflow`, `transitionWorkflow`, `failWorkflow`, `cancelWorkflow`, `cleanupAwaitingExpired` + 6h cleanup alarm |
| `lib/usage_metrics.js` | Per-action telemetry — `recordMetric`, `recordError`, `recordWorkflowStatus`, `flushQueuedMetrics`, `retryFailedMetrics` + PII redaction + separate retry queue |
| `module.js` | Top-level alarm fan-out (firestore + metrics + workflow) + `scheduleCleanupAlarm()` |
| `service.js` | SW handlers: `scan_auror`, `appriss_lookup`, `create_event` (workflow lifecycle wired), `mark_event_submitted`, `list_awaiting_final_value`, `record_scan_complete`, `probe_auror_event_value_scrape`, `open_secure_lookup` |
| `view.js` + `view.html` | Mark Submitted UI + Awaiting Final Value list |
| `content/secure_pill.js` | "Secure" pill injection on Auror search-feed cards + Person Card page |

### Legacy writer (sunset)

Lives in `~/shanesmith/extension/` — distributed at `aurorbuddy.firebaseapp.com/extension/aurorbuddy.zip`. Keeps writing legacy-shape rows (`suspectTotalValue`) until users replace it with the suite. Dashboard renders both shapes; legacy rows show under "$ legacy proxy" column and grayed-out "(legacy)" tag on the Final value column.

---

## Data model summary (corrected schema)

See `BACKEND_DATA_MODEL.md` for the full spec. The key separation:

- `transactionTotalCandidate` (number | null) — APPRISS tender amount. Reference only. Never bumped into a metric total. Source: `"appriss"`.
- `finalEventValue` (number | null) — the loss value the analyst confirms after submitting in Auror. The ONLY field that bumps `totalValueTaggedConfirmed`. Source: `user_confirmed` (V1) → `auror_page_detected` (V1.5 once selector proven) → `auror_api_fetched` (V2 once API probed).
- `finalEventValueConfidence` — `"confirmed_by_analyst" | "confirmed_from_auror_page" | "confirmed_from_auror_api" | "not_final" | "unknown"`.

Lifecycle states (see `AUROR_WORKFLOW_LIFECYCLE.md`): `import_started` → `import_prefilled` → `auror_search_complete` → `auror_person_matched` | `auror_person_no_match` → `auror_draft_staged` → `auror_draft_filled` → `awaiting_user_completion` → `submitted_detected` → `final_value_captured` → `completed`. Any state can transition to `failed` or `canceled`. Workflows stuck in `awaiting_user_completion` > 72h auto-cancel via SW alarm with `errorCode: "abandoned_timeout"`.

---

## What shipped in this session (2026-06-07)

### Docs (`unified-extension-suite/docs/`)
- `BACKEND_TELEMETRY_AUDIT.md` — cites the proxy bug at `shanesmith/extension/lib/firestore.js:370` + `:418`, `dashboard/app.js:286`, `FIRESTORE_BACKEND_PLAN.md:135`. Documents the three parallel codebases (shanesmith / puppy_workspace donor / suite) and which is live.
- `BACKEND_DATA_MODEL.md` — corrected schema separating `transactionTotalCandidate` from `finalEventValue` with full state matrix.
- `AUROR_WORKFLOW_LIFECYCLE.md` — 14-status enum, allowed transitions, value-field gating rules.
- `BACKEND_MIGRATION_PLAN.md` — 6-phase cutover (rules + dashboard back-compat → suite writes → shanesmith sunset → final value capture → archive). Legacy-record handling.
- `USAGE_METRICS_MODEL.md` — `tool_metric_events` schema, helper API, PII redaction, action vocabulary.
- `FINAL_VALUE_CAPTURE_PLAN.md` — V1 Mark Submitted (shipped), V1.5 DOM scrape observation (shipped), V2 Auror API (deferred).
- `BACKEND_OVERVIEW.md` — this file.

### Suite-side code (`unified-extension-suite/`)
- New: `modules/aurorbuddy/lib/{firestore.js,firestore_config.js,workflow_status.js,usage_metrics.js}`.
- Modified: `modules/aurorbuddy/module.js` (alarms + cleanup), `service.js` (workflow wiring, 4 new handlers, V1.5 scrape probe), `view.js` + `view.html` + `styles.css` (Mark Submitted UI), `manifest.json` (Firebase host_permissions).
- New: `tools/export_usage_metrics_report.mjs` + `tools/package.json` + `tools/README.md` (Node + Firebase Admin SDK; emits store/user/module/workflow/legacy-warning rollups as JSON or CSV).

### Shanesmith repo (`~/shanesmith/`)
- `firestore.rules` — added `/tool_workflows` and `/tool_metric_events` collections. Owner-update on `/tool_events` for the value-field set only. Legacy `timestamp == request.time` branch kept alongside new `createdAt == request.time` for cutover.
- `firestore.indexes.json` — new. Composite indexes for `tool_workflows(analystUid, status, updatedAt)` and `tool_events(analystUid, finalEventValueConfidence, createdAt DESC)`.
- `firebase.json` — `firestore.indexes` pointer added.
- `dashboard/index.html` — 5th KPI tile "Awaiting final value." Split events table "$ value" into "Candidate" + "Final value." Added "$ legacy proxy" leaderboard column. Updated descriptive text.
- `dashboard/app.js` — reads both schemas. Renders confirmed → candidate → legacy fallback per data-model matrix. CSV export includes all new value fields + `analystSource`.
- `dashboard/styles.css` — KPI grid expanded to 5 columns (responsive). New value/source tag styles.

### Deploys (this session)
- `firebase deploy --only firestore` from `~/shanesmith/` → rules + indexes live in `aurorbuddy` project.
- `firebase deploy --only hosting` from `~/shanesmith/` → dashboard live at `aurorbuddy.firebaseapp.com`. Smoke-checked: new markup + new field names present in served HTML/JS.

**Not yet deployed:** the suite-side extension itself. It still needs a build (per the suite's `RELEASING.md` flow) and distribution decision (per the migration plan, suite installs roll out alongside shanesmith for a transition period).

---

## Migration cutover state (per `BACKEND_MIGRATION_PLAN.md`)

| Phase | Status |
|---|---|
| 0 — Docs only | ✅ Done |
| 1.1 — Firestore rules deployed | ✅ Done 2026-06-07 |
| 1.2 — Dashboard back-compat deployed | ✅ Done 2026-06-07 |
| 2 — Suite writes new shape | 🟡 Code ready; install/distribute pending |
| 3 — shanesmith writes sunset | ⏳ After Phase 2 stable ~2 weeks |
| 4 — Final value capture (V1 Mark Submitted) | 🟡 Code ready; ships with Phase 2 |
| 5 — shanesmith repo archived | ⏳ Future |

---

## When you next need to...

| Task | Read |
|---|---|
| Understand the proxy bug origin | `BACKEND_TELEMETRY_AUDIT.md` |
| Add a new field to events/workflows | `BACKEND_DATA_MODEL.md` |
| Add or change a lifecycle state | `AUROR_WORKFLOW_LIFECYCLE.md` |
| Touch the Firestore rules | `~/shanesmith/firestore.rules` + this doc's migration table |
| Add a new metric action | `USAGE_METRICS_MODEL.md` §3 vocabulary + `lib/usage_metrics.js::recordMetric` |
| Implement V1.5 DOM-scrape promotion | `FINAL_VALUE_CAPTURE_PLAN.md` §2 Option B + the `auror_page_value_scrape_attempt` metric event data |
| Cut a new release of the suite | `RELEASING.md` (skip CWS sections) |
| Roll back a bad suite-side write batch | Set `chrome.storage.sync["aurorbuddy.fb_writerEnabled"] = false` via settings UI — see `lib/firestore.js::writerEnabled` |

---

## Known follow-ups (not blockers)

- **Suite extension hasn't shipped** — build + distribute via the suite's release flow when ready.
- **`auror_page_value_scrape_attempt` data hasn't accumulated yet** — needs ~1 week of suite usage to evaluate selector reliability for V1.5 promotion.
- **shanesmith retirement timeline** — pending suite stability + install replacement.
- **V2 Auror event-detail API fetch** — endpoint never probed; deferred indefinitely unless V1.5 also turns out unreliable.
