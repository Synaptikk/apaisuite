# DigitalMetrics — how to pull the Associate By Day data

**Investigated 2026-08-25**, live, against `stores.tableau.wal-mart.com` over
CDP from a dedicated debug Edge profile (`dev/launch-edge-debug.sh`). Read-only:
no workbook was modified, no custom view saved.

Companion to `VIZPICK_EXPORT_FINDINGS.md`, and it reaches the **opposite**
conclusion for this workbook — worth reading both before assuming either.

## The answer

One page load per (store, week). No crosstab export, no DOM driving.

```
https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/
  StoreFulfillmentScorecard/AssociatePerformance
  ?:iid=1&:linktarget=_self
  &Pick Date=2026-08-22,2026-08-21,2026-08-20      ← ISO, comma-separated
  &Store #=1458
```

then, in the **top** frame:

```js
const viz = window.tableau.VizManager.getVizs()[0];
const active = viz.getWorkbook().getActiveSheet();
const list = active.getSheetType() === "dashboard" ? active.getWorksheets() : [active];
const ws = list.find((s) => s.getName().trim().toLowerCase() === "associate by day");
const data = await ws.getSummaryDataAsync({ maxRows: 0, ignoreSelection: true });
```

Measured: 3 dates × store 1458 → **4,064 rows**, correctly split
(`8/22` 1440, `8/21` 1520, `8/20` 1104). Roughly 1,100–1,500 rows per store-day,
so a 7-day week is ~10k rows in one load.

## Why this workbook is not VizPick

`VIZPICK_EXPORT_FINDINGS.md` established that the VizPick workbook is
`render-mode-server` with an empty `dataDictionary`, so the crosstab export is
the only way values cross the wire. **That finding does not generalise.** On
StoreFulfillmentScorecard the Tableau **embedding JS API is live**:

| Probe | VizPick | StoreFulfillmentScorecard |
|---|---|---|
| `window.tableau` (top frame) | — | present, 25 enum keys |
| `VizManager.getVizs()` | — | **1 viz** |
| `getSummaryDataAsync` | n/a | returns real rows |
| Route taken | crosstab export replay | JS API |

So `modules/digitalmetrics/content/tableau_capture.js` was written against the
right API after all. Two corrections it still needs:

1. **Top frame only.** The inner iframe also has a `window.tableau`, but it is a
   different object — `{types, util, format, ApiCommandExecutor, base, nls, web}`
   with **no `VizManager`**. The script is declared `all_frames: true`, so the
   SW must target frame 0 or it will find the useless one.
2. **The worksheet name has a trailing space** — `"Associate By Day "`. Match on
   `.trim().toLowerCase()`. `findSheet()`'s `.includes()` happens to survive
   this, but an `===` comparison anywhere will not.

## The filters are a dependent cascade

The control captions say it out loud: *"Select Pick Date First"*, *"Select Store
Number(s) Second"*. Until a Pick Date is set, `Store #` has an **empty domain**,
and `applyFilterAsync("Store #", ["1458"])` throws an error whose entire message
is the rejected value — `1458`. That error is what made three separate attempts
look like they were failing for three different reasons.

Anything that reports 0 rows here is almost always an unscoped view, not a
broken read.

### What did NOT work

| Route | Result |
|---|---|
| `applyFilterAsync("Store #", …)` — string, number, array, zero-padded | throws, message = the value |
| `getDomainAsync()` | not a function — this is the **v1** object model |
| URL with `Store #` alone | 0 rows (no date ⇒ no data; the test was confounded) |
| Synthetic click on the quick-filter combobox | dropdown never opened |
| Crosstab export dialog | Download → Crosstab reached, but no `sheet-thumbnail-*` nodes |

The v1 filter object is minified to five methods —
`getIsExcludeMode`, `getIsAllSelected`, `getAppliedValues`, `_updateFromJson`,
`$9` — so there is no way to ask what a filter would accept. URL parameters
sidestep the whole problem because the **server** applies them before the view
renders.

## Field names ≠ control captions

URL parameters must use the **field** name, not the caption on screen.

| Caption in the UI | Field name to send |
|---|---|
| Select Pick Date First | `Pick Date` |
| Select Store Number(s) Second | `Store #` |
| Pickup Type | `Pickup_Type` |
| Fulfillment Type | `FULFMT_TYPE` |

Other filters present: `Associate`, `Associate ID`, `BU`, `Region`, `Market`,
`WM_WEEK`, `Measure Names`, `User Access`, `SPARK_SHOPPER_IND`.

`WM_WEEK` is the one filter with a readable domain via `getAppliedValues()`
(`Null, 202626…202630`). It scopes a fiscal week — but it is **not** a
substitute for `Pick Date`, because it does not satisfy the cascade: setting
WM_WEEK alone still leaves `Store #` unselectable.

## The returned shape already matches the port

`getSummaryDataAsync` hands back Tableau's MELTED form, which is exactly what
`lib/data/tableau.js::pivotAssociateData` was written to pivot:

```
["Store #","Pick Date","Associate","Associate ID",
 "Measure Names","MAX(Last Scan)","Measure Values","MIN(First Scan)"]
```

- `Pick Date` arrives as `8/22/2026`; `normalizePickDate()` folds it to
  `8/22/26`, which is what the week splitter expects. Already handled.
- `MIN(First Scan)` is the aggregated spelling; `pivotAssociateData` already
  accepts both it and `Min. First Scan`.
- Missing measures arrive as the **string** `"Null"`; `isMissing()` drops them.
- `Associate ID` is present in the feed but is deliberately dropped at the
  storage boundary — see `docs/SCHEMA.md` §4.

No transform changes are needed. The gap was only ever the driver.

## Probes

| Script | Answers |
|---|---|
| `probe-tableau-view.mjs <site> <workbook> <view>` | auth, JS API presence, render mode, controls, crosstab sheets |
| `probe-tableau-jsapi.mjs` | sheet structure + filters via the JS API |
| `probe-tableau-pull.mjs` | filter capabilities; applyFilter attempt |
| `probe-tableau-scope.mjs` | four scoping routes side by side |
| `probe-tableau-cascade.mjs` | the DOM cascade route (dropdowns never opened) |
| `probe-tableau-urlmatrix.mjs` | **the winner** — URL parameter spellings |

All require `./dev/launch-edge-debug.sh` first. Note that Chromium 136+ refuses
a debugging port on the *default* profile and fails silently, which is why that
script uses a dedicated one; SSO is a one-time cost in it.

---

# The schedule pull

Same session, same method. The portal is
`workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler`.

## The donor's scraper does not work

The donor is the unpacked extension **"Digital Metrics Data Scraper" v4.6.2**
(`Downloads\DMtool`, loaded in the analyst's Edge). Its
`popup.js::polarisExtractSchedule` walks the React fiber tree accepting the
first *"array of ≥5 people-shaped objects"* it meets. On this page that is
`workers` — and it reads the **roster** half, never reaching the shifts.

Reproduced live 2026-08-25 with `dev/probe-wfm-schedule.mjs`, which lifts the
donor's function out of `popup.js` and runs it verbatim:

```
method:      react-fiber
associates:  351
with shifts: 0 / 351
shift keys:  []
```

Its own instrumentation agrees — `[4AM DEBUG] Total associates with 4am shifts
in captured data: 0`. Everything downstream of it was dead code. Do not port
it, and do not "fix" it by widening the heuristic.

## Where the shifts actually are

`dev/probe-wfm-worker.mjs` (structure-only, safe to read):

```
workers[i] = { worker: {…roster…}, weekTotal, weekEvents: [ Day[7] ] }
Day        = { type, shift, spaceTaken, startDateTime, endDateTime, … }
Day.shift  = { shiftId, locationId, locationName, jobId, jobName,
               shiftStartDateTime, shiftEndDateTime, breaks[], … }
```

- `weekEvents[0]` is a **seven-element array, Saturday first** — the same week
  convention `weeks.js` already uses, so day index maps to date by addition.
- A day with no `.shift` is normal: Available / Unavailable / Time Off / LOA /
  Not Scheduled / Inactive.
- **`startDateTime` / `endDateTime` on the day wrapper are Luxon objects**
  (`isLuxonDateTime`, `.ts`, `.c{year,month,day,hour,minute}`). Returning one
  through `chrome.scripting` structured-clones Luxon's locale cache and loses
  the instant, so times must be flattened to ISO **in the page**.
- Store number: `worker.locations[0].locationId`, falling back to the
  `NNNN-WMSC` text on the page.

## Two corrections the port makes deliberately

**Week start comes from the data, not from `new Date()`.** The donor derived
the Saturday from today, which made backfill impossible and mislabelled the
week whenever the page showed a different one.

**The 5am grid floor is reported, not hidden.** `TIME_SLOTS[0]` is `"5-6"`, so
`slot = hour - 5`. Overnight (`10:00pm–7:00am`) and early (`4:00am`) shifts are
both real on this roster and have no honest slot. The donor clamped with
`Math.max(0, h - 5)`, filing a 4am start in the same cell as a 5am one — the
bug all its `[4AM DEBUG]` lines were chasing. `wfm_parse.js::toSlot` still
clamps (the grid has nowhere else to draw) but returns `clamped: true`, counts
them, warns, and keeps the true times on `shiftStart`/`shiftEnd`.

## Only the current week is reachable

The portal renders one week at a time and the extractor reads what is on
screen. Backfill would mean driving its week navigation — a separate job.

## Privacy note

`dev/wfm-schedule-probe.json` (the donor-replay dump) contains real names with
**`birthDate` and `hireDate`** — more sensitive than anything this module is
designed to hold. It is gitignored via `*-probe.json`; delete it when done.
`wfm-worker-probe.json` and `wfm-fiber-probe.json` are structure-only by
construction and carry no personal data.

Note the `.gitignore` pattern is `*-probe.json`, so a dump must be named with
the suffix LAST. `probe-tableau-view.mjs` originally wrote
`tableau-probe-<workbook>.json`, which that pattern does not match; fixed.
