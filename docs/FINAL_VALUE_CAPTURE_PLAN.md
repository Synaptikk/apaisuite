# AurorBuddy — Final Event Value Capture Plan

How we actually fill `finalEventValue` once a workflow reaches `submitted_detected`. The data model and lifecycle docs left this as a deliberate gap; this is the plan.

**TL;DR — V1 ships as "Mark Submitted" user-confirmed entry.** Automatic capture paths are documented but staged behind V1 because none are robustly proven and the user's prompt explicitly warned: *"Do not build brittle or unsafe automation if the page flow is unknown."*

---

## 1. The capture surface — what we'd be reading

After the analyst clicks Publish in Auror, the tab redirects to `https://app.us.auror.co/event/{id}`. The form they just submitted included a "Value" field (theft amount in USD). That value is now:

1. **Stored in Auror's backend** — addressable via `/api/spa/EventApi/...` if the right read endpoint exists.
2. **Rendered on the post-submit page** — visible DOM, scrapeable with `chrome.scripting.executeScript`.
3. **Not anywhere else.** Not in APPRISS. Not in `searchPeople`. Not derivable from anything we already have.

The capture problem is: which of those two paths is reliable, and what's our fallback when both fail.

---

## 2. Strategy options, ranked by reliability

### Option A — User confirms via "Mark Submitted" UX (RECOMMENDED for V1)

**Trigger.** When the suite detects the Auror tab landed on `/event/{numericId}` after our filler ran, the suite UI gets a toast:

```
✓ Auror event #4892733 created.
Enter the final value the team will be credited with (you can correct this any time):
  [ Final value ]  $ [______]
                   [ Mark Submitted ]    [ Skip — value unknown ]
```

On "Mark Submitted": `transitionWorkflow(id, "final_value_captured", { patch: { finalEventValue: <user-entered>, finalEventValueSource: "user_confirmed", finalEventValueCapturedAt: serverTimestamp, finalEventValueConfidence: "confirmed_by_analyst", valueDisplayLabel: "Final event value confirmed" } })`.

On "Skip": `transitionWorkflow(id, "final_value_captured", { patch: { finalEventValue: null, finalEventValueUnknownReason: "user_skipped_mark_submitted", finalEventValueConfidence: "unknown", valueDisplayLabel: "Final event value unknown" } })`.

**Why V1.** Zero brittleness (no DOM scrape, no API spelunking). Zero risk (we never write something we didn't read with intent). Zero analyst surprise (they see the number they're attesting to). User can correct later via the "Awaiting final value" list on the dashboard.

**Downside.** Cognitive overhead for the analyst (one extra click) and people will skip it. We accept that — a clear "unknown" is better than a wrong number.

### Option B — Scrape the Auror /event/{id} post-submit page (DEFERRED to V1.5)

After our filler runs and the tab navigates to `/event/{id}`, inject a content script that reads the rendered value off the DOM (selector TBD — depends on Auror's UI markup).

**Why deferred:** the markup is a moving target (Auror redesigns happen without notice), and an over-aggressive selector that grabs the wrong number would silently corrupt the metric we're trying to fix. The plan to add it later:

1. Run a one-week observation phase where the suite logs the DOM-scrape *attempt* result alongside the user-confirmed Option A value, but only WRITES the user-confirmed one. Metric event: `auror_page_value_scrape_attempt` with `result: "success" | "selector_miss" | "value_disagrees_with_user"`.
2. If scrape succeeds and matches user-confirmed value in >95% of observations, promote scrape to a fallback: when the user opts to "Skip" but a scrape succeeded with high confidence, write `finalEventValue` with `finalEventValueSource: "auror_page_detected"` and `finalEventValueConfidence: "confirmed_from_auror_page"`.
3. If scrape diverges from user value, stop. The discrepancy means our selector is wrong or Auror has multiple "Value"-looking fields. Don't ship.

**Selectors to investigate when V1.5 starts** (not before — premature):
- The Value field on `/event/{id}` likely renders as `<input>` or `<span>` with a `data-testid` or aria-label containing "Value" or "Loss". Inspect live before assuming.
- Beware Auror's currency formatting: probably `"$ 1,234.56"` or `"1234.56"` depending on locale. Parse defensively.

### Option C — Re-fetch the event detail via Auror's API (DEFERRED past V1.5)

After capturing the `aurorEventId` from the redirect URL, call something like `https://app.us.auror.co/api/spa/EditEvent/getEvent?eventId={id}` (endpoint name TBD). Reuse the captured Auror JWT (`chrome.storage.session.aurorbuddy.auror.jwt`).

**Why deferred:** we haven't probed Auror's event-detail endpoints yet. The donor's `lib/auror_event.js` only knows how to drive the form, not read the resulting event. Without a known endpoint that returns the "Value" field in a stable shape, this is speculation.

**Investigation plan when this becomes V2:**
1. Sniff what Auror's own /event/{id} page loads in DevTools Network panel.
2. Identify the JSON response that contains the Value field.
3. Confirm the endpoint accepts the captured JWT (no CORS issue, no extra header).
4. Confirm the response schema is stable across a few different event types.
5. Wire as `lib/auror_event.js::fetchEventDetail(eventId)`.

If that works it becomes the most reliable source (server-canonical, no DOM dependence). If it doesn't, no harm — Options A and B still work.

### Option D — Background SW polls Auror for status changes (NOT RECOMMENDED)

After submit, poll the event endpoint every hour for changes (in case the analyst edits the value later in Auror itself). Catches retroactive corrections.

**Why not recommended:** adds persistent API traffic against Auror's servers, drains the analyst's JWT TTL, and creates a "we have data Auror didn't tell us about" surprise. Better: the dashboard's "Awaiting final value" list lets the analyst pull-update, no poll required.

---

## 3. Fields written, by strategy

| Strategy | `finalEventValue` | `finalEventValueSource` | `finalEventValueConfidence` | `finalEventValueCapturedAt` |
|---|---|---|---|---|
| A — User confirmed | user input | `user_confirmed` | `confirmed_by_analyst` | serverTimestamp on click |
| A — User skipped | null | null | `unknown` | null (set `finalEventValueUnknownReason: "user_skipped_mark_submitted"`) |
| B — Page scrape success (V1.5+) | scraped number | `auror_page_detected` | `confirmed_from_auror_page` | serverTimestamp |
| B — Page scrape failed (V1.5+) | null | null | `unknown` | null (set `finalEventValueUnknownReason: "auror_page_scrape_failed"`) |
| C — API fetch success (V2) | fetched number | `auror_api_fetched` | `confirmed_from_auror_api` | serverTimestamp |
| C — API fetch failed (V2) | null | null | `unknown` | null (set `finalEventValueUnknownReason: "auror_api_no_value_field"` or `"auror_api_fetch_failed"`) |

In all cases the workflow transitions to `final_value_captured` regardless of whether a value was actually set — "captured" here means "the capture attempt was completed," even if the outcome is "still unknown." That terminates the awaiting state so the user isn't pestered forever.

---

## 4. Retroactive value entry

For workflows that landed in "submitted_detected" without `finalEventValue`, the dashboard exposes an "Awaiting final value" view. Each row has an inline editor:

```
Suspect: Smith, J.   Store: 1458   Event: #4892733   [ Confirm value: $ ___ ]
                                                        [ Save ]
```

On Save: PATCH `/tool_events/{aurorEventId}` with the value fields per Option A. Firestore rules permit the owning `analystUid` to update those specific fields. This is the explicit "edit-later" path the migration plan §4 enables.

---

## 5. Out of scope (the user's "do not do" rules — restated for the implementer)

- Do NOT auto-fill `finalEventValue` from `transactionTotalCandidate` if the user skips. The result is `unknown`, not a fallback.
- Do NOT auto-fill `finalEventValue` from `suspectTotalValue` (the legacy proxy). Same rule.
- Do NOT show a pre-populated number in the "Final value" input that the user could blindly confirm. The input starts blank. The user types.
- Do NOT mark a workflow `completed` until both `submitted_detected` and `final_value_captured` have happened (regardless of whether `finalEventValue` itself ended up null — "captured" means the capture step is done).

---

## 6. UX detail for V1 "Mark Submitted"

Mount point: lives inside the suite's AurorBuddy module view, NOT in the Auror tab. Triggered by detecting the `/event/{id}` redirect via the existing webRequest filter or by polling `chrome.tabs.query` for the URL pattern post-submit.

Behavior:
- Suite UI shows a small banner at the top of the AurorBuddy module: "Auror event #N submitted. Confirm final value."
- Clicking the banner expands an inline form (no modal, no popup).
- "Skip" is just as easy to click as "Mark Submitted" — we genuinely want unknown over coerced.
- Banner auto-dismisses 72h after submit even if untouched (matches `awaiting_user_completion` timeout per the lifecycle doc).

Edge cases:
- User submits two events in quick succession → two banners stack (newest on top).
- User refreshes the suite UI mid-workflow → banner re-renders from the persisted workflow row.
- User uninstalls the extension after submitting but before confirming → workflow stays at `submitted_detected` forever, surfaces on the dashboard's "Awaiting" list, can be confirmed via the inline editor (§4).

---

## 7. Telemetry on the capture itself

Every capture attempt emits a `tool_metric_events` row with `actionName: "final_value_captured"` and `result: "success" | "skipped" | "failed"`. Lets us measure capture rate over time — if "skipped" % is high, the UX is too easy to dismiss; if "failed" % is high, the automation (B or C, once shipped) is brittle.
