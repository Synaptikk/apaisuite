# Polling Plan

Per-source refresh cadence recommendations. The trade-off is always
"freshness vs. cost vs. risk of getting rate-limited or noisy in logs."
Defaults below are intentionally conservative; tighten only with evidence.

**Last reviewed:** 2026-06-02.

---

## Defaults at a glance

| Source | Suggested Interval | Stale After | Cache Duration | Cost / Latency Notes |
|---|---|---|---|---|
| Absences (A) | **15 min** | 30 min | 15 min | Multi-page WebForms flow; per-pull cost is real (3–10s p50, up to ~60s when MAC-error retries fire). Don't go below 15 min. |
| Compliance (B) | **6 hours** | 12 hours | 6 hours | Due-date data changes slowly. Hourly is wasteful. |
| Accident Evidence (C) | **30 min** | 60 min | 30 min | Evidence status changes when investigators upload — 30 min catches it within a half hour, which is fast enough. |
| CVP (D) | **15 min** | 30 min | 15 min | Hoops GraphQL is fast (1–2s). Could go faster but the numbers update infrequently — 15 min is plenty. |
| Register Long/Short (E) | **manual only V1** → **6 hours V1.5** | 24 hours | manual | The Power BI report is the slowest, most expensive pull. V1 is import-only. V1.5 (automated) should run no more than 6h. |

These are **suite-wide defaults**. The user can override per source via
the dashboard's Store Settings (stored in `chrome.storage.sync`, see
[DATA_CONTRACTS.md §7](DATA_CONTRACTS.md#7-user-settings-cross-cutting)).

---

## The reasoning per source

### Absences (15 min)

**Why this cadence.**
- IVR data updates within minutes of an associate calling in. Reasonable to
  surface a callout within 15 min.
- Per-pull cost: opens (or reuses) a background tab, navigates 3 page
  loads, scrapes a table. Median ~5s. Worst case (MAC errors retried 5×):
  ~60s.
- Web-farm rejects ~50% of POSTs (documented in `closinglist/content/ivr.js`).
  At 4 polls/hour × 50% reject × 3 progressing steps per flow, that's
  ~6 retry round-trips per hour. Visible in logs but acceptable.

**Why not faster.**
- Below 10 min and the retry-storm becomes ugly.
- Below 5 min and we'd be hitting the IVR cluster more often than the
  closinglist module typically does in a closing shift workflow — risk of
  drawing IT attention.

**Cache lifetime.** 15 min — equal to the poll interval. If a pull fails,
the previous result is still shown but the widget shows "stale" badge after
30 min.

**Stale after.** 30 min (2× poll interval). After this, the absences widget
shows a yellow "stale" state with last-success time visible.

### Compliance (6 hours)

**Why this cadence.**
- Due dates don't change minute-to-minute. New tasks appear when the
  Enviance system creates a recurring task instance — typically at the
  start of a week or month.
- Hour-by-hour polling provides ~zero new information vs. 6-hourly.
- Per-pull cost: one (probably small) JSON XHR. Cheap.

**Cache lifetime.** 6 hours.

**Stale after.** 12 hours. (Soft fail mode: if Enviance is down for half a
day, the dashboard surfaces the existing list as stale rather than going
blank.)

### Accident Evidence (30 min)

**Why this cadence.**
- Evidence status changes when investigators or store leads upload
  documentation — happens unpredictably during the day. 30 min keeps the
  feedback loop tight enough to be useful without hammering.
- Per-pull cost: one form POST or one XHR per the two report types. Likely
  fast (1–3s).

**Cache lifetime.** 30 min.

**Stale after.** 60 min.

### CVP (15 min)

**Why this cadence.**
- Hoops GraphQL is fast. The data updates daily (or weekly, depending on
  metric), but the cache lifetime should still match a "fresh enough"
  user expectation when they look at the dashboard.
- 15 min ensures the user sees current numbers within a quarter-hour of
  refreshing any other widget.

**Cache lifetime.** 15 min.

**Stale after.** 30 min.

**Per-week persistence.** Store every successful pull keyed by
`(storeNbr, wmWeekNbr)`. The trend chart reads from this persisted history,
not from the live cache — so the trend stays useful even if the current
week's number is stale.

### Register Long/Short (manual V1, 6h V1.5)

**Why manual for V1.**
- The Power BI export workflow is mechanically expensive: open report
  tab, wait for render, drive slicer, click Export → Excel, capture
  download, parse, store.
- V1 should not auto-poll this — the user explicitly drags-drops the
  XLSX export (or pastes from clipboard) when they want fresh data.
- Risk: an auto-poll that fails silently because Power BI's tenant token
  expired would leave stale register data invisibly. Manual V1 avoids this
  entirely.

**Why 6 hours for V1.5.**
- The register data updates at end of day (or end of shift). 4 pulls per
  day is plenty.
- 6 hours also limits how often we open a background Power BI tab — that
  tab is heavy and shows up in Edge's task manager. Once per shift is
  reasonable; once per 30 min is not.

**Cache lifetime.** Until next import (V1) or 6 hours (V1.5).

**Stale after.** 24 hours — register data older than a day should be
shown with a strong stale indicator.

---

## Implementation notes

### `chrome.alarms`-driven scheduling

The suite already uses `chrome.alarms` for the workvivo heartbeat
(`modules/workvivo/module.js`). The Live Dashboard module follows the
same pattern: register one alarm per source at `module.js` top level so
Chrome wakes the SW on the scheduled tick:

```js
chrome.alarms.create("livedashboard.absences",   { periodInMinutes: 15 });
chrome.alarms.create("livedashboard.compliance", { periodInMinutes: 360 });
chrome.alarms.create("livedashboard.accident",   { periodInMinutes: 30 });
chrome.alarms.create("livedashboard.cvp",        { periodInMinutes: 15 });
// register: NO alarm in V1 (manual). V1.5: 360 min.

chrome.alarms.onAlarm.addListener(onLiveDashboardAlarm);  // ← top-level!
```

**Critical:** register listeners at top-level of `module.js`, not inside a
handler. `chrome.alarms`'s 1-minute minimum is per-alarm; the
above is well within bounds.

### Per-source independence

Each source pulls in its own handler and writes its own freshness record.
A failure in one source MUST NOT block another. Default the handler shape
to:

```js
async function pullSource(sourceId, pullFn) {
  const startedAt = Date.now();
  try {
    const data = await pullFn();
    await persistSource(sourceId, data);
    await writeFreshness(sourceId, { lastSuccess: startedAt, lastError: null });
  } catch (e) {
    await writeFreshness(sourceId, { lastError: redact(e.message) });
    // Do NOT throw — let other alarms fire independently.
  }
}
```

### Adaptive backoff (later)

V1 doesn't need it. If polling becomes wasteful (consistently failing
source pulls), add exponential backoff with a cap:

```
nextInterval = baseInterval * Math.min(2^consecutiveFailures, 8)
```

So a source failing 4× in a row would back off to 8× its base interval
(e.g., compliance: 6h → 48h max).

### Refresh Now button

Triggers parallel `pullSource(...)` calls for every source, ignoring
cached freshness. Implemented as a single SW handler
`livedashboard.refreshAll` that fan-outs and returns when all complete (or
~30s timeout — partial results still get persisted).

### Last refresh visibility

The dashboard header shows a "last refreshed: HH:MM" timestamp per
widget, sourced from `freshness.lastSuccess`. Stale state
(`lastSuccess < now - staleAfterMs`) renders a yellow badge with a
tooltip explaining the last error if any.
