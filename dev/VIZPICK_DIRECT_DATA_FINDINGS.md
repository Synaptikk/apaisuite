# VizPick direct JSON investigation — 2026-09-11

## Result

**A direct structured-data route works.** Tested with standalone Playwright
attached to the user's authenticated Edge debug profile on localhost:9222.
No change to the production module was made.

The prior statement that server rendering makes crosstab export the only way
to get numbers is incorrect. The bootstrap may contain only rendered images,
but a separate worksheet summary API returns the underlying summary values,
including tooltip measures, as JSON. This investigation read the live page's
own `vqlweb.js` command implementation, then exercised that command.

## Live route and permission boundary

POST to the current session's
`/commands/tabdoc/api-get-worksheet-summary-logical-table-data` using FormData:

```json
{
  "visualIdPresModel": "{\"worksheet\":\"Download Department Breakout (Current Day)\",\"dashboard\":\"VizPick Details\"}",
  "versionName": "1.0",
  "maxRows": "0",
  "ignoreAliases": "false",
  "ignoreSelection": "true"
}
```

Build the session base from live `tsConfig.site_root`, `repositoryUrl`, and
`sessionid`; never persist/share a session ID across tabs. This is Tableau's
internal API used by its embedding implementation, not a discovered public
database connection or a standalone unauthenticated API.

The page reports `allow_summary: true`, `allow_export_data: true`, and
`allow_view_underlying: false`. Only permitted worksheet summary access was
used; the restricted underlying-data route was not probed. Existing filters
and the session's Store parameter still apply.

Response:
`vqlCmdResponse.cmdResultList[0].commandReturn.dataTablePresModel` contains
`showDataTable`, `showDataFormattedTable`, `showDataTableColumnPresModels`,
`referencedColumns`, and `topN`. The first two are JSON strings containing
`table.schema` and `table.tuples`. Join schema unique names to column metadata
for captions; don't rely on numeric positions or hardcoded calculation IDs.

All five tested sheets returned HTTP 200, nonempty rows, and `topN: 0`:

| Sheet | JSON ms | Direct CSV export ms | JSON rows |
|---|---:|---:|---:|
| Department breakout | 159 | 279 | 328 (41 departments × 8 measures) |
| VizPick donut health | 95 | 165 | 3 |
| Department groups health | 103 | 152 | 9 |
| Location details | 131 | 1,087 | 233 |
| Last update | 114 | 276 | 1 |

These are individual warm-session samples for store 1, not latency guarantees.
The CSV comparison used Tableau's CSV command and tempfile fetch directly,
not dialog-driving time. The dialog was opened once to discover current sheet
GUIDs for the comparison. JSON requires worksheet names and no export GUIDs.

## Correctness checks against CSV, same store/session

- 328 department metric comparisons matched after converting percentage
  fractions to the CSV's rounded percentage representation.
- All five health values matched. The third health tuple contains the tooltip
  measures; the first two contain donut slices with null tooltip values.
- 233 location rows matched the export count. All 932 checked fields matched:
  suggested picks seen/done, last scanner, and last scan timestamp. Timestamps
  and null representations needed normalization. No scanner identities were
  written to the findings or probe output.
- The summary table has no synthetic `Total` department row. Sums of six
  additive measures matched the export's Total: suggested seen/done, total
  picked, cases seen/expected, and overstock exceptions. Never average department
  percentages to form store percentages.
- Group data was fetched successfully for all ten market stores, but the full
  group/field equality check remains implementation validation work. The probe
  does not claim that every field in every store has been compared.

The JSON is not the existing parser's input shape. A production adapter must
pivot department measure tuples, handle duplicate/space-sensitive location
captions, preserve raw precision, normalize nulls/dates, and select the populated
health tuple. Do not pass it through the CSV parser unchanged.

## Actual ten-store benchmark

Market 120's roster was observed on the live summary view:
658, 669, 756, 1089, 1215, 1458, 2988, 3660, 5151, 5173.

For each store, replayed the actual `tabdoc/set-parameter-value` request learned
from a UI Store change, awaited its response, then requested the four JSON
datasets sequentially. No export requests/files/dialogs were used in this timed
loop. Each session had exclusive ownership by one lane.

| Run | Stores | Wall time | Scope |
|---|---:|---:|---|
| One session | 10/10 | 68.736 s | Already warm; includes 30 s deliberate pacing |
| Three independent sessions | 10/10 | **30.809 s** | One warm session plus two new sessions; includes their 5.591 s startup |

The three-session run also included 750 ms before each summary request (30 s
aggregate across lanes, overlapping in wall time). Aggregate parameter-request
time was 31.019 s; aggregate JSON-request time was 4.205 s. All four datasets
were nonempty for every store. Location row counts agreed between serial and
parallel runs: 202, 184, 248, 230, 205, 154, 186, 352, 133, 201 respectively.

This is about 2–6× faster than the user's reported 1–3 minutes, **not** a paired
A/B measurement against the installed extension. It excludes production
parsing/storage/rendering, initial sign-in, and a cold first session. Do not
advertise 30.8 s as guaranteed production latency. The remaining dominant cost
is the approximately three-second Store parameter response.

## Recommended implementation

1. Make the worksheet summary JSON command the primary path for all four
   datasets and the last-update stamp. Keep the existing export fallback.
2. Keep three independent sessions; never change stores concurrently within
   one session. Await the actual Store parameter response, not arbitrary traffic.
3. Add a tested adapter and prove parity for totals, percentages, groups,
   location identities, null values, and pagination/truncation behavior.
4. Benchmark the complete extension pull, including initialization, persistence,
   and UI readiness; record per-stage times and successful complete stores.

A single request for the entire current-day market, a browser-free session
bootstrap, direct database access, and skipping Tableau's parameter rendering
were **not established**. The tested improvement avoids file generation and
downloads while retaining authenticated Tableau sessions.

## Reproduction

With a signed-in debug browser and VizPickDetails open:

```text
node dev/probe-vizpick-direct-data.cjs
node dev/benchmark-vizpick-direct-data.cjs
node dev/benchmark-vizpick-direct-data.cjs --lanes=3
```

`CDP_URL` defaults to `http://127.0.0.1:9222`. `PLAYWRIGHT_MODULE` can select
an installed Playwright package; the fallback uses the desktop bundled runtime.
The first probe installs temporary helpers in the page, so keep that tab open
between commands. The benchmark closes only its additional tabs. It changes
the temporary session's Store parameter and does not save a Tableau custom view.

Probes print timings, schemas, counts, and store numbers, not credentials or
associate rows. Raw comparison data stays in the temporary page's memory.
