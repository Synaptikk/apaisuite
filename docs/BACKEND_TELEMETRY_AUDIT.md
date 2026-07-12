# AurorBuddy Backend Telemetry — Audit

Read alongside `BACKEND_DATA_MODEL.md` (the corrected design), `AUROR_WORKFLOW_LIFECYCLE.md`, `BACKEND_MIGRATION_PLAN.md`, `USAGE_METRICS_MODEL.md`, and `FINAL_VALUE_CAPTURE_PLAN.md`. This doc is the why; those docs are the what.

**Snapshot date:** 2026-06-07
**Audited extension version (deployed):** `shanesmith/extension` v1.0.2
**Audited extension version (suite target):** `modules/aurorbuddy` v0.1.62

---

## 1. Where the write code actually lives

The actively-shipped AurorBuddy extension is built from `~/shanesmith/extension/`, distributed at `https://aurorbuddy.firebaseapp.com/extension/aurorbuddy.zip`. It is **not** the unified-extension-suite's `modules/aurorbuddy/` (which has no Firestore code today) and **not** the `~/Documents/puppy_workspace/aurorbuddy/extension/` donor (a stale earlier snapshot the suite was ported from).

Three parallel copies exist on disk:

| Workspace | Role | Has Firestore code? |
|---|---|---|
| `~/shanesmith/extension/` | Live deployed source | Yes — `lib/firestore.js`, `lib/firestore_config.js` |
| `~/Documents/puppy_workspace/aurorbuddy/extension/` | Donor snapshot (stale) | No |
| `unified-extension-suite/modules/aurorbuddy/` | Suite port (active dev) | No |

**Implication:** any user-facing bug fix today must land in shanesmith. The suite port is the chosen retirement target — see `BACKEND_MIGRATION_PLAN.md`.

---

## 2. Backend topology

- **Firebase project:** `aurorbuddy` (separate from QRCallBox), apiKey `AIzaSyBVbIuRW8qSXS_CVhpkKGlwrt-AFWTrWnw`, appId `1:592946265453:web:d242207755758e659f2e64`.
- **Hosting:** `aurorbuddy.firebaseapp.com` — dashboard + extension zip + crx + base64 fallback + Edge GPO updates.xml.
- **Auth in extension:** Firebase Anonymous (REST), UID stable per install. Refresh token in `chrome.storage.local`. ID token in `chrome.storage.session`, refreshed at 55 min.
- **Auth in dashboard:** Firebase email/password. Rule `isPasswordUser()` gates read access to `tool_scans` and `tool_metrics`; `tool_events` is `request.auth != null` (so anonymous extension can read its own writes for the dedup filter introduced in v0.1.60).
- **Wire:** Extension calls Firestore REST (`https://firestore.googleapis.com/v1/...`) directly. No Firebase JS SDK in the extension. ~200 KB saved + sidesteps MV3 SW idle-sleep issues with the SDK's WebSocket assumptions.
- **Collections in active use:** `tool_scans`, `tool_events`, `tool_metrics`, `tool_cache_stores` (~7-day Walmart store-list cache), `tool_cache_scans` (whole-scan cache, doc id `${homeStore}_${miles}_${days}`).

---

## 3. Current payload shapes (shanesmith)

Source of truth: `shanesmith/extension/lib/firestore.js`.

### `tool_scans/{autoId}` — written by `writeScan()` (line 380)

`commonRowFields()` (line 250) plus the per-scan payload:

```
analystUid, aurorUserName, aurorUserEmail, aurorUserId,
aurorUserStore, aurorUserMarket, aurorUserTitle, toolVersion,
timestamp (serverTimestamp),
homeStore, miles, days,
storesFound, aurorSuspects, actionableSuspects, secureMatched,
elapsedMs
```

No transaction or event-value fields. Telemetry only. Correct as-is.

### `tool_events/{autoId}` — written by `writeEvent()` (line 384)

```
analystUid, aurorUserName, aurorUserEmail, ..., toolVersion,
timestamp (serverTimestamp),
homeStore, suspectName, suspectPersonId,
suspectTotalValue,             ← THE PROXY (see §4)
aurorEventId, aurorEventUrl,
transactionIds, secureStore, secureRegister,
receiptSaved
```

### `tool_metrics/{uid}` — written by `bumpMetrics()` (line 302)

```
firstUsedAt, lastUsedAt, identity fields (overwritten each write),
scansRun        (increment +1 per scan write),
eventsSubmitted (increment +1 per event write),
totalValueTagged (increment by suspectTotalValue per event write)  ← THE BUG
```

---

## 4. The proxy bug — exact cite

The user's complaint: *"the current backend save flow is using the transaction total as the event/case value. That is wrong."* The actual proxy in use is one step further removed than "transaction total" — it's the Auror cross-store aggregate. The semantic complaint stands either way.

### 4a. Spec origin

`shanesmith/docs/FIRESTORE_BACKEND_PLAN.md:135` defines:

> `suspectTotalValue: number,  // $ from Auror at search time (proxy)`

`FIRESTORE_BACKEND_PLAN.md:158` defines:

> `totalValueTagged: number    // running sum of suspectTotalValue`

The spec acknowledges `suspectTotalValue` is a *proxy* — but then assigns it the role of "dollar impact" without ever flagging that the true per-event value is unknown until after the user submits. The implementation faithfully ships the buggy spec.

### 4b. Where `suspectTotalValue` originates

`shanesmith/extension/lib/models.js` (and donor `pipeline/models.py`): sourced from Auror's `searchPeople` API response field `totalValue` — Auror's *aggregate* dollar impact for the person across all stores in their visible history. It is NOT:
- the value of THIS event
- the value of THIS suspect's activity at the home store
- the value of THIS transaction set being keyed

It is, at best, a "high-water mark" proxy that systematically over-states the per-event value (it sums across stores and across prior events).

### 4c. Where the bug fires

**Per-event:**

`shanesmith/extension/lib/firestore.js:366-371`

```
} else if (kind === "event") {
  await createDocWithServerTimestamp("tool_events", merged);
  await bumpMetrics({
    eventInc: 1,
    valueInc: Number(payload.suspectTotalValue) || 0,
  });
}
```

**Retry path (same bug):**

`shanesmith/extension/lib/firestore.js:414-419` — `flushQueue()` re-applies the same `valueInc: Number(item.payload.suspectTotalValue) || 0`.

**Dashboard render:**

`shanesmith/dashboard/app.js:267` — Per-analyst leaderboard "$ tagged" column = `formatMoney(r.totalValueTagged || 0)`.
`shanesmith/dashboard/app.js:286` — Recent Events table "$ value" column = `formatMoney(r.suspectTotalValue || 0)`.
`shanesmith/dashboard/app.js:328` — CSV export includes `suspectTotalValue` per event.

### 4d. Where the value is NOT captured anywhere

There is no field on any document — `tool_events`, `tool_metrics`, or elsewhere — that holds the actual per-event dollar impact as confirmed by the analyst after Auror submission. There is no field that distinguishes "this is a proxy / estimate" from "this is confirmed." Every numeric value in the dashboard's money columns today is the Auror cross-store aggregate, displayed as if it were the case value.

---

## 5. What data is available at each lifecycle moment

| Moment | What's known | What's not |
|---|---|---|
| Import / pre-fill start | suspect identity (name, Auror person ID), home store, secure store, register, transaction set + their tender totals (from APPRISS), `suspectTotalValue` (Auror cross-store aggregate) | The analyst's eventual theft-loss estimate. Whether the event will be submitted at all. |
| Auror form prefilled, awaiting user | All of the above | Same. The analyst may abandon the draft, change the suspect, change the transaction set, change the store, or correct the description before publishing. |
| User clicks Publish in Auror | All of the above + Auror redirect URL → `/event/{id}` if successful | The analyst-assessed final value is in the Auror form's "Value" / "Description" fields; not currently scraped. |
| Post-submit page rendered (Auror) | Same + the published event ID | Same gap: the actual analyst-entered "Value" field is in Auror's own backend, not visible here unless we re-fetch the event detail via Auror's API. |

**Conclusion:** there is no moment at which the *correct* final event value can be safely inferred from data the extension already has. The transaction total is wrong because it's pre-investigation. The Auror aggregate is wrong because it spans events. The only correct value is the one the analyst enters into the Auror form. To capture that, we must either scrape the Auror form on Publish, fetch the event detail back from Auror's API after submit, or ask the analyst directly via a "Mark Submitted" + "Final value" UX. See `FINAL_VALUE_CAPTURE_PLAN.md`.

---

## 6. Existing local-only storage

For completeness, all on-device writes (donor extension, shanesmith extension, and suite port):

- `chrome.storage.session.<id>.auror.jwt` — captured Auror Bearer JWT (TTL 20 min).
- `chrome.storage.sync.<id>.aurorUsername` — analyst's Auror login email (donor pattern; suite uses `aurorbuddy.aurorUsername`).
- `chrome.storage.local.<id>.show-all-stores` — UI toggle.
- `chrome.storage.local.fb_refreshToken` / `fb_uid` / `fb_aurorIdentity` / `fb_metricsInitialized` / `fb_pendingWrites` — Firebase auth + identity + retry queue (shanesmith only today).
- `chrome.storage.session.fb_idToken` / `fb_idTokenAt` — Firebase ID token cache (shanesmith only today).
- `chrome.storage.local.shell.telemetry` — 500-entry suite-wide local ring buffer via `host.logging.emit`. Never sent anywhere remote. AurorBuddy doesn't currently emit to it.

---

## 7. Existing usage metrics

The deployed dashboard at `aurorbuddy.firebaseapp.com` reports:
- Per-analyst totals: `scansRun`, `eventsSubmitted`, `totalValueTagged` (the buggy one), `lastUsedAt`, `firstUsedAt`.
- Per-event row: `timestamp`, `aurorUserName`, `suspectName`, `homeStore | secureStore`, `suspectTotalValue` (the buggy one), `aurorEventUrl`.
- Per-scan row: `timestamp`, `aurorUserName`, `homeStore`, `miles`, `storesFound`, `aurorSuspects → actionableSuspects → secureMatched`, `elapsedMs`.

**Not tracked:**
- Per-action telemetry — "user opened module", "user clicked Search", "user clicked Save evidence", "APPRISS lookup completed", "auror person matched", etc. The dashboard counts scans and event-submissions but cannot answer "which workflow step is the funnel falling off at?"
- Store-level rollup beyond per-analyst home store.
- Workflow status — a pre-filled event that the user never publishes is invisible. There is no "started but not submitted" row anywhere.
- Confidence / source labels on the dollar fields.

---

## 8. Confirmed-unknown gaps

1. **Real final event value.** Not in the data anywhere. See §5 + `FINAL_VALUE_CAPTURE_PLAN.md`.
2. **Submission detection.** `writeEvent()` is called by `background.js` only after the filler reaches the Auror Done screen, so "events written" ≈ "events the filler completed." But the filler completing is not the same as the analyst publishing — the user can still cancel the draft after Auror redirects them to `/event/{id}`. There is no follow-up "still exists" check.
3. **Workflow attribution beyond submit.** Once written to `tool_events`, the row is append-only (per Firestore rules). The analyst correcting the final value in Auror later is invisible to us.
4. **Cross-extension double-writes.** If a user runs both the shanesmith extension and the suite (different extension IDs, both with the same UID via Firebase Anonymous? — no, anonymous UID is per-install, so they'd be two distinct UIDs), the same workflow can produce two `tool_events` rows. Today shanesmith is the only writer so this is theoretical; once the suite ships writes it becomes real.

---

## 9. Recommended next reads

| If you want to know... | Read |
|---|---|
| What the corrected schema looks like | `BACKEND_DATA_MODEL.md` |
| What states a workflow goes through | `AUROR_WORKFLOW_LIFECYCLE.md` |
| How to handle legacy `suspectTotalValue` rows + the shanesmith → suite handoff | `BACKEND_MIGRATION_PLAN.md` |
| What per-action analytics to add | `USAGE_METRICS_MODEL.md` |
| How to actually capture the final value | `FINAL_VALUE_CAPTURE_PLAN.md` |
