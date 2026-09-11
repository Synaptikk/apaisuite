# VizPick source — how much history the Tableau workbook actually serves

Probed live 2026-09-09 against `stores.tableau.wal-mart.com`, site
OnlineGrocery, workbook `VizPick` (id 750, luid
`f2884d22-b979-4e50-a97f-e0765b888028`, project "Backroom", revision 13.6,
last published 2026-08-26). Read-only; nothing was changed on the server.

## Where the data comes from

`vizportal getDatasources` for the workbook lists two **BigQuery extracts**
(embedded, refreshed daily — last refresh `2026-09-09T14:22:57Z`):

| id | name | type |
|---|---|---|
| 54003 | `VizPick New Datasource` | bigquery, extract |
| 54002 | `Custom SQL Query (SUPPORT)` | bigquery, extract |

plus five `sqlproxy` (published) sources (`CAP Details oi`, `CAP Summary oi (2)`,
`vizpick_details_pallet_id`, `E2E Support FAQ Data`, `Report Notification`).
Workbook size 120 MB. Our site role is **Viewer**: `.twb` download is 404,
Metadata API is 403, REST `/api/3.27/sites/{site}/workbooks` is 401 on the
browser cookie alone. So the BigQuery table names are not readable from here;
the workbook owner (`a0b14mk`, Adam Bay, per `getWorkbook`) or the
BigQuery skill are the routes to the raw daily table.

## History depth by sheet (summary view `views/VizPick/VizPick`)

Every sheet on the dashboard, with its `sheetdocId` (stable per publish — the
same GUIDs worked across three fresh sessions):

| sheet | sheetdocId | what it returns |
|---|---|---|
| Download Summary by Store | `{1725614D-0BFF-4AE0-A47D-8585B4FEEDEE}` | 17-col store rollup for the selected period bucket (what the module captures) |
| Download Summary by Department | `{00FE5C68-6AD6-4844-9925-1364B11D39AB}` | dept rollup, same period |
| **weekly line summary** | `{44047B0C-D8A4-42DB-810F-8DC931AF4B33}` | **14 WM weeks** (19→32 on 2026-09-09): `wm_week_nbr, Cases % (Weekly), Locations % (Week), New VizPick (Weekly), Overstock % (weekly), Pick % (week)` |
| Hourly Bar Chart (Summary) | `{07297D04-8932-4889-B289-5896CFC219B8}` | yesterday only, 24 hourly columns × dept_group (Fresh/F&C/GM) |
| Last update (summary) | `{DB6D7BEE-5A53-42A1-A635-1B98101AF912}` | `9/9/2026,` |
| summary date bucket name | `{F88F2BB4-4A5D-472B-92B9-33BB4811FD67}` | label of the active bucket, e.g. `Avg Last 7-Days` |
| Show Bucket | `{2613E3D8-5283-4263-99F6-B40BC40C178E}` | `(Yesterday)` — raw bucket value in parens |
| Show Bucket2 | `{55F51437-1008-4D82-AFC0-2DF8158CED10}` | 500 LogicException on export |
| VizPick / Cases / Locations / Picks / Overstock Donut Health (Summary) | `{3D5D1023-…}`, `{D8A83FAC-…}`, `{B33A7224-…}`, `{DDBD0D2E-…}`, `{859AD396-…}` | ring values |
| Overstock Exceptions Yesterday (Summary) | `{A6090303-B2AB-4572-9ECA-E0098C5C131B}` | not exported |
| Store Breakout (Phone), dept donuts (summary) (+2), Metric Definitions Moble | see dialog | not exported |

**There is no sheet with a date column at store grain.** Per-day history older
than yesterday is not served by this workbook. The extract certainly holds
≥30 days (the period buckets need it) and ≥14 weeks (the weekly line), but the
only shapes exposed are: yesterday at store/dept grain, bucketed aggregates
(WTD / Last WM Week / Last 7 / Last 30) at store/dept grain, and **weekly at
whatever scope the filters select**.

Location-level detail (`Download Location Details` on `VizPickDetails`) is
current-day only. No date control exists on that view. **Historical location
data cannot be pulled from this source.**

## What DOES work and would be cheap to add

1. **URL filters scope the summary view.** Opening
   `…/t/OnlineGrocery/views/VizPick/VizPick?:embed=y&Store=1458` returns the
   by-store sheet with only that store and the **weekly line for that store**
   (values differ from the all-store export, so the filter is honoured).
   `Market=120` should behave the same (quick filter "Market" exists; not
   separately verified). That is 14 weeks × 5 metrics per store for the cost of
   one page load + one POST/GET.
2. **The period bucket can be switched** through the quick-filter dropdown
   (ref-click → `tabdoc:categorical-filter-by-index`), and the by-store export
   then reflects it (store 1458: 10,513 cases seen for Yesterday vs 66,424 for
   Last 7 Days). The quick filter's field name is hidden (title reads
   `Filter  Inclusive`). A URL param `Date Bucket=…` is a real field — it
   blanked the dashboard when given `5. Last 30 Days` — but none of ~25 guessed
   raw values selected a bucket, and by-store exports started returning
   `500 LogicException` in every session opened with that param. Treat the
   URL route for the period as **unresolved**; the DOM route is proven.
3. **Replay is session-agnostic on the GUIDs.** Learning them once (this file)
   removes the dialog step entirely for the summary view.

## Location Details — what the user-id sheet actually holds (verified 2026-09-09)

`VizPickDetails` at ≥1400px lists (tablet-layout names/GUIDs; the desktop
layout uses the unsuffixed names the module matches on):

| sheet | sheetdocId (1400px layout) |
|---|---|
| Download Location Details (2) | `{26BCD369-0175-42F5-A336-B649F84C2554}` |
| Download Department Breakout (Current Day Phone) | `{C99ABB4C-7198-414C-A640-3749DDEF0B16}` |
| Last update | `{7D7FC53C-B5B4-4BE3-BB90-143597C616A0}` |

Location Details for store 1458: **151 rows, one per bin**, columns
`Location, Status, Plts, Seen Today, last_seen_timestamp, user_id, Total Picked,
Cases Seen %, Location Age, loc color, ZN(SUM(cases_expected)), ZN(SUM(cases_seen)),
ZN(SUM(clearance_tags)), ZN(SUM(deleted_tags)), ZN(SUM(pick_anyway_picked_tags))`.

It is a **current-state** table, not a scan log: each bin shows the last scan
(`last_seen_timestamp`, e.g. `9/8/2026 11:51:49 AM`), who did it (`user_id`,
one WIN), and `Location Age` in days (22 observed). So "older" scans survive
only until the next scan of the same bin. The dashboard's own `date_bucket`
filter (caption `date_bucket`, field `none:date_bucket:nk`) is on every
Details sheet, but `?date_bucket=Yesterday` blanks the view — the Details
extract holds only the current-day bucket. **A per-day, per-user scan history
does not exist on this server**; it would have to come from the BigQuery
table behind `VizPick New Datasource`, where `date_bucket` is evidently a
derived column over a real scan timestamp.

Sheets also present on the desktop Details layout (from `filtersJson`
`targetSheets`, not yet exported): `Download Locaitons (Clearance Cases)`,
`Download Locaitons (Modular Deleted Cases)` (+ Phone variants),
`Department Groups Donuts Health`, the four donut sheets.

## Period bucket — raw values and the URL route

Raw values (from the `Show Bucket` helper sheet after switching the quick
filter): `Yesterday`, `Last 30 Days` (others presumably `Week to Date`,
`Last WM Week`, `Last 7 Days`). The dropdown labels are aliases with the
`n. ` prefix. `?Date Bucket=Last 30 Days` in the URL is **accepted as a field
but does not move the quick filter** (Show Bucket still prints `(Yesterday)`),
while a non-member value blanks the dashboard. Setting the period therefore
stays a DOM action (ref-click the dropdown, ref-click the option, ~5 s).

## Gotchas hit while probing

- **`500 LogicException` on export = the sheet is not in the layout the
  session was bootstrapped with.** A narrow Browser pane (467px) loads the
  *phone* layout, which has none of the `Download …` sheets; resizing after
  load does not help — the vizql session keeps its layout. Load the view at
  ≥1400px (`resize_window` BEFORE `navigate`), then export. This, not rate
  limiting, was every 500 seen today.

- `find` / ref-clicks only see the top frame. Use the `/t/<site>/views/…?:embed=y`
  form (viz at top level, `window.tsConfig` present), not the `#/site/…`
  portal router form (viz in an iframe).
- With a non-default viewport emulation the pane scales the page and
  coordinate clicks miss; ref-clicks work.
- After several exports in quick succession the export command started
  answering `500 LogicException` while `Show Bucket` still exported fine.
  Unclear whether that is the `Date Bucket` URL filter or a server-side
  cool-down; `VIZPICK_EXPORT_FINDINGS.md` already records a WAF trip from
  raw-fetch probing. Space probes out.
