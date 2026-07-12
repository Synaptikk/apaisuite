# AurorBuddy Backend Migration Plan

Move from the shanesmith deployment (proxy bug shipped) to the unified-suite writer (corrected schema per `BACKEND_DATA_MODEL.md`). The Firebase project stays the same; the schema gains new fields + new collections; existing rows are preserved and labeled `legacy_proxy_suspect_total_value`.

---

## 1. Constraints

- **No destructive data loss.** Every existing row in `tool_events`, `tool_scans`, `tool_metrics` stays where it is. They are business records (per `FIRESTORE_BACKEND_PLAN.md:286`).
- **No simultaneous writes from both extensions to the same schema version.** Cut-over must be ordered: dashboard reads compatibly first, then suite writes, then shanesmith retires.
- **No silent semantic change to existing fields.** `suspectTotalValue` is NOT redefined — it keeps its current (incorrect-for-the-question-asked) meaning. New correct fields are added alongside.
- **Dashboard must keep working during the transition.** Users opening `aurorbuddy.firebaseapp.com` between cut-over phases must not see broken tables.

---

## 2. Phase order

```
Phase 0   →  Phase 1   →  Phase 2   →  Phase 3   →  Phase 4   →  Phase 5
docs only    rules +      suite       shanesmith   final value   shanesmith
             dashboard    starts      stops        capture       repo
             compat       writing     writing      shipped       archived
                          new shape   (sunset)     (V1 manual)
```

### Phase 0 — Docs only (current session)

All six docs in `unified-extension-suite/docs/`. No code changes. No deploy. Sanity check the schema in design review before any byte hits prod.

### Phase 1 — Firestore rules + dashboard back-compat

Goal: dashboard renders correctly whether a doc has only legacy fields, only new fields, or both.

1. **Add rules for new collections.** `firestore.rules` diff:

   ```
   match /tool_workflows/{id} {
     allow create: if request.auth != null
                   && request.resource.data.analystUid == request.auth.uid
                   && request.resource.data.createdAt == request.time;
     allow update: if request.auth != null
                   && request.auth.uid == resource.data.analystUid
                   && onlyWritableFields(["status", "statusHistory", "updatedAt",
                                          "transactionContext", "aurorPersonMatchStatus",
                                          "aurorPersonId", "aurorEventDraftStatus",
                                          "aurorSubmitStatus", "aurorEventId",
                                          "aurorEventUrl", "errorCode", "errorMessageRedacted"]);
     allow read:   if request.auth != null;
     allow delete: if false;
   }

   match /tool_metric_events/{id} {
     allow create: if request.auth != null
                   && request.resource.data.analystUid == request.auth.uid
                   && request.resource.data.timestamp == request.time;
     allow read:   if isPasswordUser();
     allow update, delete: if false;
   }
   ```

   Plus an `onlyWritableFields()` helper that compares `request.resource.data.diff(resource.data).affectedKeys()` against an allowlist.

   `tool_events` rules also need a one-shot update relaxation to allow the owning analyst to set `finalEventValue` + `finalEventValueSource` + `finalEventValueCapturedAt` + `finalEventValueConfidence` + `finalEventValueUnknownReason` + `aurorEventStatus` + `aurorEventSubmittedAt` + `valueDisplayLabel` + `updatedAt`. All other fields stay frozen post-create. Append a `migratedAt` field is also allowed once per doc.

2. **Update `dashboard/app.js` to read both shapes**, ranked by preference:
   - For event "$ value" column: prefer `finalEventValue` if non-null AND confidence is one of `confirmed_*`; else show "—" with hover "Awaiting analyst confirmation" if `valueDisplayLabel === "Final event value unknown"`; else show `transactionTotalCandidate` with label "Candidate" if non-null; else show `suspectTotalValue` greyed-out with hover "Legacy proxy — not a confirmed value" (for pre-migration rows).
   - For per-analyst "$ tagged": read `totalValueTaggedConfirmed` if present, else fall back to today's `totalValueTagged` with a small "(legacy proxy basis)" footnote.
   - Add new KPI "Awaiting final value: N" from `totalValueTaggedPending` if present.

3. **Deploy dashboard.** Doesn't break anything because all rows still only have legacy fields.

### Phase 2 — Suite-side writer ships, writing new schema

1. Suite's `modules/aurorbuddy/lib/firestore.js` ships per the data model. Writes ONLY new shape: `tool_workflows` rows on import, `tool_events` rows on submit (with new value fields), `tool_metric_events` rows per action, `tool_metrics/{uid}` rollups with new fields.
2. Suite extension is sideloaded for the first user(s). Two installs writing concurrently is fine — Firebase Anonymous UIDs are per-install, so suite installs get distinct UIDs from shanesmith installs of the same person. Identity overlap (same `aurorUserEmail`) is reconciled at dashboard read time, not write time.
3. Dashboard now sees new-shape rows alongside legacy ones. Both render correctly per Phase 1.

### Phase 3 — shanesmith writes are sunset

1. shanesmith ships a "this extension is being replaced" notice + a link to install the suite. No new feature work.
2. After ~2 weeks (or whenever active install count of shanesmith < N — pick N per the user's deploy telemetry), stop new shanesmith deploys.
3. shanesmith extension does NOT get the new schema retrofit — not worth the engineering cost when the suite is the canonical replacement. Existing shanesmith installs keep writing legacy-shape rows until the user uninstalls / replaces.

### Phase 4 — Final value capture lands in suite

Per `FINAL_VALUE_CAPTURE_PLAN.md`. V1 = "Mark Submitted" UX with user-confirmed value entry. Once shipped:

1. New rows start arriving with `finalEventValue` confirmed.
2. Dashboard's "Dollar impact tagged (confirmed)" KPI starts moving — for the first time, it's a number anyone can stand behind.
3. Existing rows without `finalEventValue` are surfaced in the new "Awaiting final value" table. Analysts can click in and confirm retroactively (UI: `tool_events` update path enabled for the owning analyst, scoped to value fields).

### Phase 5 — shanesmith repo archived

1. Once shanesmith installs are below the keep-the-lights-on threshold, the repo is moved to read-only. The unified suite becomes the only AurorBuddy.
2. The donor at `~/Documents/puppy_workspace/aurorbuddy/` was already stale (audit confirmed) — left in place per CLAUDE.md's "donor is never edited" rule.
3. The Firebase project stays. Hosting page is rewritten to point to the suite's install URL (or kept stable if the suite ships from `qrcallbox.com` per the suite's release flow — see `RELEASING.md`).

---

## 3. Legacy-record handling

For all existing `tool_events` rows written before Phase 2:

| Field | Treatment |
|---|---|
| `suspectTotalValue` | Kept. Read by dashboard only as a fallback display value with a "legacy proxy" label. |
| `finalEventValue` | Null. Confidence is `not_final`. |
| `valueDisplayLabel` | `"Legacy proxy (suspectTotalValue)"`. Set by a one-off cleanup script (see §4) OR derived at dashboard read time. Prefer the derived-at-read approach so we don't run a mass write. |
| `transactionTotalCandidate` | Null (we don't have the per-txn snapshot from then). |
| `analystSource` | `"shanesmith"`. Derived at read time if missing. |

For `/tool_metrics/{uid}`:

| Field | Treatment |
|---|---|
| `totalValueTagged` (legacy) | Frozen — NOT carried forward into the new metric. Read-only in the dashboard under a separate "Legacy proxy total" column behind a Show-legacy toggle. |
| `legacyTotalValueTaggedProxy` | Initialized once per analyst at Phase 2 cut-over from the then-current `totalValueTagged`. Never bumped after. |
| `totalValueTaggedConfirmed` | Starts at 0. Bumped per Phase 4 capture. |

**Why we don't backfill `finalEventValue` from `suspectTotalValue`:** that IS the proxy bug. Backfilling would be the same lie at a different timestamp. The legacy rows are permanently "unknown" for their final value, which is the honest answer.

---

## 4. Optional one-off cleanup (Cloud Function or local script)

Lives at `unified-extension-suite/tools/firestore_label_legacy_events.mjs`. Runs once at Phase 2 cut-over. Reads every `tool_events` row, and for any row missing `valueDisplayLabel`:
- Sets `valueDisplayLabel: "Legacy proxy (suspectTotalValue)"`.
- Sets `analystSource: "shanesmith"`.
- Sets `migratedAt: serverTimestamp`.

This is *optional* — the dashboard can derive the same labels at read time. Run the script only if dashboard query perf becomes an issue. The shanesmith repo already ships a similar `tools/cleanup_legacy_scans.mjs` so the pattern is familiar.

---

## 5. Rule-deployment ordering (must follow)

If you deploy in the wrong order you'll either lock out the live extension or accept un-validated writes. Order:

1. Deploy expanded `firestore.rules` (allows new collections, allows `tool_events` value-field updates).
2. Deploy dashboard with both-shape read support.
3. Cut suite-side writes. New rows arrive in `tool_workflows` and (eventually) updated `tool_events`.
4. Monitor for a week. If anything breaks, suite-side writer can be flag-gated off via `chrome.storage.sync.aurorbuddy.writerEnabled = false` (helper exposed on the firestore client) and shanesmith's still writing — no data loss.
5. Phases 3–5 as above.

---

## 6. Test plan

### Pre-deploy (local Firebase emulator)

```
firebase emulators:start --only firestore,auth,hosting
```

- Seed legacy-shape rows mimicking shanesmith output. Verify the updated dashboard renders them correctly (legacy proxy label visible, KPI legacy footnote present, no broken cells).
- Seed new-shape rows from a test suite-side writer. Verify dashboard renders them correctly (confirmed values appear in "Dollar impact tagged (confirmed)", awaiting-final shows correct count).
- Seed mixed-shape rows (same analystUid in both shapes). Verify both totals roll up to the right analyst.

### Per-phase smoke (against the real Firebase project)

- Phase 1: open dashboard signed in, count of rows unchanged, no console errors, "Awaiting final value" tile shows 0 (no new-shape rows yet).
- Phase 2: install suite for a single analyst. Run one full workflow (import → submit → capture). Confirm `tool_workflows` row + `tool_events` row + `tool_metric_events` rows + `tool_metrics` updates. Confirm shanesmith install (if also present on same machine) keeps producing legacy-shape rows for unrelated workflows — they don't cross-pollinate.
- Phase 4: confirm "Mark Submitted" UX writes `finalEventValue` and the dashboard tile increments.

---

## 7. Rollback

- **Suite writes badly:** disable via `chrome.storage.sync.aurorbuddy.writerEnabled = false` push (shipped from the suite's settings panel; no rebuild needed). Suite-installed users immediately stop writing. shanesmith installs keep going.
- **Dashboard renders wrong:** revert `dashboard/app.js` in `shanesmith` and redeploy hosting — the file is small and self-contained.
- **Rules change breaks existing writes:** redeploy previous `firestore.rules` from git. The current rules don't reference any new fields so reverting is risk-free until Phase 2.

---

## 8. Out of scope for this plan

- Cloud Functions for nightly aggregation / archival — not needed at current volume (audit doc §7: 900 writes/day across the whole team).
- BigQuery export — defer until business asks for cross-month analytics that Firestore can't serve.
- Cross-extension UID reconciliation (merging shanesmith UID and suite UID for the same person) — not needed if dashboard rollups happen by `aurorUserEmail` instead of UID. Already today's behavior on the leaderboard.
