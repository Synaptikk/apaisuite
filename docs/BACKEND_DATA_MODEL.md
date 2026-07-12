# AurorBuddy Backend — Corrected Data Model

The schema the suite-side writer should implement and the dashboard should expect once migrated. Reasoning in `BACKEND_TELEMETRY_AUDIT.md`; legacy-record handling in `BACKEND_MIGRATION_PLAN.md`.

**Status:** spec. Suite implementation lives at `modules/aurorbuddy/lib/firestore.js` (corrected) once §6 ships.

---

## 1. Hard rules

1. **`transactionTotalCandidate` is never written to `finalEventValue`.** Ever. Not at import. Not in a fallback path. Not as a default. These two fields are semantically distinct and must remain separately settable. Any code that would assign one to the other must instead leave `finalEventValue: null` with `finalEventValueUnknownReason` set.
2. **Confirmed final value originates from the analyst or the Auror page, never from APPRISS or Auror search.** APPRISS gives tender amounts. Auror's `searchPeople` gives cross-store aggregates. Neither is the per-event theft value.
3. **Metric rollups never sum `transactionTotalCandidate` into a "dollar impact" total.** Only `finalEventValue` (when present and `finalEventValueConfidence ∈ {confirmed_by_analyst, confirmed_from_auror_page}`) contributes to `totalValueTagged`.
4. **The schema distinguishes confirmed values from estimates everywhere they appear** — in the document, in queries, and in the rendered UI. The current dashboard's "$ value" column must become "Final value (confirmed)" with a separate "Transaction total (candidate, not final)" column when applicable.

---

## 2. The four record types

### A. Transaction data — embedded inside `tool_workflows` and `tool_events`

Source/reference info pulled from secure/APPRISS at the moment the workflow began. Used for traceability of which transactions the workflow was built around. Never appears as a "value" column.

```ts
type TransactionSnapshot = {
  transactionId:           string;    // APPRISS reference, opaque string
  transactionStore:        string;    // store the txn occurred at
  transactionRegister:     string;
  transactionDate:         string;    // ISO 8601
  transactionTotalCandidate: number;  // APPRISS ticketamount — the TENDER, not theft value. Labeled "Candidate" so no caller treats it as final.
  paymentSummaryRedacted:  string;    // optional, e.g. "VISA ****1234" — never the full PAN
}

type TransactionSet = {
  transactionTotalCandidateSum: number;        // sum across transactions[] — for UI hint only, NEVER bumped into a metric total
  candidateCount:               number;
  transactions:                 TransactionSnapshot[];
}
```

### B. Workflow record — `/tool_workflows/{workflowId}`

Tracks every AurorBuddy-assisted workflow from import through eventual outcome. **One row created at import.** Updated as status changes. Replaces today's "only-on-submit" `tool_events` semantics.

```ts
type Workflow = {
  workflowId:                string;            // client-generated UUID, also the doc id
  createdAt:                 Timestamp;         // serverTimestamp on create
  updatedAt:                 Timestamp;         // serverTimestamp on each transition

  // Identity (copied from common header — see §4)
  analystUid:                string;
  analystSource:             "shanesmith" | "suite";  // see migration plan
  aurorUserName:             string;
  aurorUserEmail:            string;
  aurorUserId:               string;
  storeNumber:               string;
  toolVersion:               string;

  // Source — which workflow inside the suite started this
  source:                    "AurorBuddy" | "LicenseIntake" | "SparkBuddy" | "AurorImport" | string;
  moduleName:                string;            // e.g. "aurorbuddy"
  actionName:                string;            // e.g. "import_to_auror"

  // Lifecycle (see AUROR_WORKFLOW_LIFECYCLE.md)
  status:                    WorkflowStatus;    // discrete enum
  statusHistory?:            { status: WorkflowStatus; at: Timestamp; note?: string }[];

  // Substep tracking — set as the workflow advances
  aurorPersonMatchStatus:    "matched" | "no_match" | "ambiguous" | "skipped" | null;
  aurorPersonId:             string | null;
  aurorEventDraftStatus:     "staged" | "filled" | "abandoned" | null;
  aurorSubmitStatus:         "submitted_detected" | "not_submitted" | "unknown" | null;

  // Suspect snapshot (operational metadata only; NEVER PII beyond name + Auror person id)
  suspectName:               string;            // already shown on dashboard today, keep
  suspectAurorPersonId:      string | null;

  // Transaction context (reference data — NOT the case value)
  transactionContext:        TransactionSet | null;

  // Auror linkage (filled when known)
  aurorEventId:              string | null;
  aurorEventUrl:             string | null;

  // Failure context (set if status === "failed")
  errorCode:                 string | null;     // machine-parseable, e.g. "auror_form_fill_timeout"
  errorMessageRedacted:      string | null;     // human-readable, no PII, no tokens
}
```

### C. Event record — `/tool_events/{aurorEventId}`

Created when a workflow reaches `submitted_detected`. Doc ID is the Auror event id (not random) so updates from later final-value capture land deterministically. **Update-on-write** for the value fields specifically, per §5.

```ts
type Event = {
  aurorEventId:              string;            // = doc id
  workflowId:                string;            // back-ref to /tool_workflows
  createdAt:                 Timestamp;
  updatedAt:                 Timestamp;

  // Identity (copied at submit time)
  analystUid:                string;
  analystSource:             "shanesmith" | "suite";
  aurorUserName:             string;
  aurorUserEmail:            string;
  storeNumber:               string;
  toolVersion:               string;

  // Auror metadata
  aurorEventUrl:             string;
  aurorEventStatus:          "submitted" | "draft" | "deleted" | "unknown";
  aurorEventSubmittedAt:     Timestamp | null;  // null if we never confirmed submit

  // Suspect snapshot
  suspectName:               string;
  suspectAurorPersonId:      string | null;

  // VALUE (the whole point of the rewrite) — see §3 for state matrix
  transactionTotalCandidate:           number | null;
  transactionTotalCandidateSource:     "appriss" | "secure" | "user_entered" | null;

  finalEventValue:                     number | null;
  finalEventValueSource:               "user_confirmed" | "auror_page_detected" | "auror_api_fetched" | null;
  finalEventValueCapturedAt:           Timestamp | null;
  finalEventValueConfidence:           "confirmed_by_analyst" | "confirmed_from_auror_page" | "confirmed_from_auror_api" | "not_final" | "unknown";
  finalEventValueUnknownReason:        string | null;  // e.g. "user_skipped_mark_submitted", "auror_page_scrape_failed", "auror_api_no_value_field"

  // Display labels — derived but stored so the dashboard doesn't need to know the matrix
  valueDisplayLabel:                   "Final event value confirmed" | "Final event value unknown" | "Transaction total candidate (no final)" | "Legacy proxy (suspectTotalValue)";

  // Reference data
  transactionContext:                  TransactionSet | null;
}
```

### D. Usage metric event — `/tool_metric_events/{autoId}`

Per-action telemetry (separate from per-analyst rollups). Append-only. Detailed schema and helper API in `USAGE_METRICS_MODEL.md`.

### E. Per-analyst rollup — `/tool_metrics/{uid}` (revised)

```ts
type Metrics = {
  firstUsedAt:        Timestamp;
  lastUsedAt:         Timestamp;
  aurorUserName:      string;
  aurorUserEmail:     string;
  aurorUserId:        string;
  storeNumber:        string;
  analystSource:      "shanesmith" | "suite";

  // Action counts
  workflowsStarted:        number;
  workflowsCompleted:      number;   // status === "completed"
  workflowsAwaitingFinal:  number;   // status === "awaiting_user_completion" or "submitted_detected" without finalEventValue
  workflowsFailed:         number;
  workflowsCanceled:       number;
  eventsSubmittedConfirmed: number;  // status === "submitted_detected" — NOT same as legacy eventsSubmitted

  // Dollar rollups (only confirmed values; estimates are NEVER summed here)
  totalValueTaggedConfirmed:      number;   // sum of finalEventValue where confidence is confirmed_*
  totalValueTaggedPending:        number;   // count of events with no finalEventValue, for funnel visibility
  legacyTotalValueTaggedProxy:    number;   // running sum from pre-migration suspectTotalValue rows. Frozen at migration cut-over; clearly labeled. See migration plan.
}
```

---

## 3. Value-field state matrix

| Lifecycle state | `transactionTotalCandidate` | `finalEventValue` | `finalEventValueConfidence` | `valueDisplayLabel` |
|---|---|---|---|---|
| Workflow started, no APPRISS yet | null | null | unknown | "Final event value unknown" |
| APPRISS data loaded, pre-submit | number (sum of txn tenders) | null | not_final | "Transaction total candidate (no final)" |
| Submitted, no capture attempted yet | number | null | unknown | "Final event value unknown" |
| Submitted, user confirmed value | number | number | confirmed_by_analyst | "Final event value confirmed" |
| Submitted, auror page scrape worked | number | number | confirmed_from_auror_page | "Final event value confirmed" |
| Submitted, auror API fetch worked | number | number | confirmed_from_auror_api | "Final event value confirmed" |
| Submitted, capture attempted + failed | number | null | unknown | "Final event value unknown" (set `finalEventValueUnknownReason`) |
| **Legacy row (pre-migration)** | null | null | not_final | "Legacy proxy (suspectTotalValue)" + keep original `suspectTotalValue` field for back-compat read; see migration |

---

## 4. Common header (every doc)

Equivalent to today's `commonRowFields()` (firestore.js:250). Add `analystSource` and `workflowId` (where applicable).

```ts
type CommonHeader = {
  analystUid:        string;
  analystSource:     "shanesmith" | "suite";   // NEW — disambiguates which writer
  aurorUserName:     string;
  aurorUserEmail:    string;
  aurorUserId:       string;
  aurorUserStore:    string;
  aurorUserMarket:   string;
  aurorUserTitle:    string;
  toolVersion:       string;
  workflowId?:       string;                   // present on event + metric_event docs that belong to a workflow
}
```

---

## 5. Mutation rules

`tool_workflows` is **update-allowed for the owning analystUid only**, on specific fields only (status, statusHistory append, value fields, errorCode). Today's append-only rule on `tool_events` was too strict for the lifecycle model — split:

- `/tool_workflows/{id}` — create + update by owner (specific paths only).
- `/tool_events/{aurorEventId}` — create + update by owner. The value-field set above is the only updatable set; identity fields are frozen at create.
- `/tool_metric_events/{id}` — append-only. Per `USAGE_METRICS_MODEL.md`.
- `/tool_metrics/{uid}` — owner-only write via increment transforms.

See `BACKEND_MIGRATION_PLAN.md` for the firestore.rules diff that enforces these.

---

## 6. Why this shape

- **Workflow row at import (not at submit)** — gives the funnel visibility we lack today. Today's metric "eventsSubmitted = 3" hides "but the analyst started 12 imports." Funnel analysis is impossible without per-workflow rows.
- **Doc id = aurorEventId on events** — enables idempotent post-submit updates without query-then-write.
- **Value field set instead of a single number** — the bug being fixed is "one number that the dashboard reads regardless of where it came from." A field set means the dashboard cannot accidentally render an estimate as a confirmed total without explicitly opting in.
- **`analystSource`** — required during the shanesmith → suite transition (`BACKEND_MIGRATION_PLAN.md`). Lets the dashboard show "shanesmith records still rolling in: N" until shanesmith is fully retired.
- **`legacyTotalValueTaggedProxy` frozen at cut-over** — keeps the historical "$ tagged" number visible (it's been live for months and people remember it) but stops it growing, so it can't keep accruing the proxy bug as new events come in.

---

## 7. What the dashboard must change

Concrete; informs the migration plan:

- KPI tile "Dollar impact tagged" → "Dollar impact tagged (confirmed)". Read `totalValueTaggedConfirmed`, not `totalValueTagged`.
- Add KPI tile "Awaiting final value: N" reading `totalValueTaggedPending` count.
- Recent events table "$ value" column → two columns: "Transaction total (candidate)" and "Final value" — final col shows "—" with a tooltip "Awaiting analyst confirmation" when null.
- Leaderboard "$ tagged" column unchanged on label, but read `totalValueTaggedConfirmed`. The old summed-proxy number is moved to a separate "Legacy proxy total" column behind a "Show legacy" toggle, off by default.
- CSV export includes both `transactionTotalCandidate` and `finalEventValue` + `finalEventValueConfidence` + `finalEventValueSource`.

---

## 8. Anti-patterns (do not do these)

- `finalEventValue = transactionTotalCandidate` as a default — defeats the whole rewrite.
- `finalEventValue = suspectTotalValue` — defeats the whole rewrite plus reintroduces the cross-store-aggregate proxy.
- Single number called `value` with no source/confidence — round-trips us back to today's ambiguity.
- Auto-inferring a confidence label without an explicit source — if you don't know where it came from, it's `unknown`, period.
- Storing the analyst's keystroke-by-keystroke entries as the value before they submit — wait for a deliberate "Mark Submitted" action or a confirmed Auror page state.
