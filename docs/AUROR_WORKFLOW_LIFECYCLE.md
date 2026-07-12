# AurorBuddy Workflow Lifecycle

Status enum + transition rules for `/tool_workflows/{workflowId}` per `BACKEND_DATA_MODEL.md`. Implemented as `lib/workflow_status.js` in the suite.

---

## 1. Statuses

```ts
type WorkflowStatus =
  | "import_started"            // user clicked "Import to Auror" / equivalent. Row created.
  | "import_prefilled"           // APPRISS data pulled into the workflow record.
  | "auror_search_complete"      // resolveAurorPerson finished, regardless of match.
  | "auror_person_matched"       // found an Auror person id; aurorPersonId set.
  | "auror_person_no_match"      // search ran but no person id resolved.
  | "auror_draft_staged"         // /event/new tab opened, ready for driveForm.
  | "auror_draft_filled"         // driveForm completed, Auror form is populated.
  | "awaiting_user_completion"   // returned control to user; they must Publish in Auror.
  | "submitted_detected"         // we detected the Auror /event/{id} redirect.
  | "final_value_captured"       // finalEventValue set (any source).
  | "completed"                  // submitted_detected + final_value_captured, OR user explicitly marked complete.
  | "failed"                     // any step errored unrecoverably (errorCode set).
  | "canceled"                   // user explicitly canceled, or workflow was abandoned past TTL.
  | "unknown";                   // last-resort fallback (should never be set deliberately).
```

`statusHistory` is appended on every transition: `{ status, at: serverTimestamp, note? }`. Cap at 50 entries client-side; trim oldest on overflow.

---

## 2. Allowed transitions

```
                          import_started
                                │
                                ▼
                          import_prefilled
                                │
                                ▼
                      auror_search_complete
                          /          \
                         ▼            ▼
            auror_person_matched   auror_person_no_match
                         \          /
                          ▼        ▼
                       auror_draft_staged
                                │
                                ▼
                       auror_draft_filled
                                │
                                ▼
                    awaiting_user_completion
                       /        |        \
                      ▼         ▼         ▼
        submitted_detected   canceled   (timeout → canceled)
                  │
                  ▼
        final_value_captured
                  │
                  ▼
              completed

Any state ──[error]──▶ failed
Any state ──[user]──▶ canceled
```

Rules:
- A workflow may NOT skip from `import_started` → `submitted_detected` without passing through the intermediate states. If the funnel jumps, log a metric event `workflow_skipped_state` and emit a warning — the state machine is the source of truth.
- `submitted_detected` is the only state in which `finalEventValueConfidence` may transition from `unknown` / `not_final` to a confirmed value.
- `completed` requires both `submitted_detected` reached AND `finalEventValue != null` with confirmed confidence. Otherwise the workflow stays in `submitted_detected` until capture happens (or `failed` / `canceled`).

---

## 3. Hard rules on value handling per state

| State | `transactionTotalCandidate` | `finalEventValue` | Allowed to set finalEventValue? |
|---|---|---|---|
| import_started | null | null | No |
| import_prefilled | may set (from APPRISS) | null | No |
| auror_search_complete | unchanged | null | No |
| auror_person_matched / no_match | unchanged | null | No |
| auror_draft_staged | unchanged | null | No |
| auror_draft_filled | unchanged | null | No |
| awaiting_user_completion | unchanged | null | No |
| submitted_detected | unchanged | null OR set if capture succeeded at submit moment | Yes — only with explicit `finalEventValueSource` |
| final_value_captured | unchanged | required | Already set |
| completed | unchanged | required | Frozen |
| failed | unchanged | unchanged | No |
| canceled | unchanged | unchanged | No |

**Never** computed from `transactionTotalCandidate`. **Never** computed from any APPRISS or Auror-search-returned field. **Never** set without `finalEventValueSource`.

---

## 4. Timeouts and abandoned workflows

- `awaiting_user_completion` for > 72h → automatically transition to `canceled` with `errorCode: "abandoned_timeout"`. Implemented by `chrome.alarms` poll in the SW + a Cloud Function fallback (TBD; see migration plan).
- `submitted_detected` for > 72h with no `final_value_captured` → stay in `submitted_detected`; show on dashboard as "Awaiting final value: N." Do NOT auto-cancel — the analyst may genuinely confirm next week.
- `failed` is terminal. No retry from a failed state — start a new workflow if the user wants to try again.

---

## 5. Identifiers

- `workflowId` — client-generated UUID v4. Doc id of the `/tool_workflows` row.
- `aurorEventId` — Auror's own event id, captured from `/event/{id}` redirect. Doc id of the `/tool_events` row.
- A workflow has exactly one `aurorEventId` once it reaches `submitted_detected`. Both records back-reference each other (`workflowId` on the event, `aurorEventId` on the workflow).

---

## 6. State transitions API

Exposed in `modules/aurorbuddy/lib/workflow_status.js`. Single entry point — call sites must not write `status` directly to Firestore.

```ts
import { transitionWorkflow } from "./lib/workflow_status.js";

await transitionWorkflow(workflowId, "import_prefilled", {
  patch: { transactionContext: { ... } },
});

await transitionWorkflow(workflowId, "failed", {
  patch: { errorCode: "auror_form_fill_timeout", errorMessageRedacted: "form did not load within 30s" },
});
```

`transitionWorkflow` enforces:
- Transition is allowed per §2 (throws on invalid).
- `statusHistory` is appended.
- `updatedAt` is set to serverTimestamp.
- The patch object's keys are intersected with the writable-fields allow-list (so a caller can't accidentally smuggle in a `finalEventValue` from the wrong state).

On Firestore write failure → enqueue same retry queue as `writeEvent` (firestore.js pattern). State transitions are best-effort but durably retried.
