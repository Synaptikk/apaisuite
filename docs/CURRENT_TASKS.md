# Current Tasks

Active work only. Nothing finished, nothing speculative. When work lands,
remove the entry — don't leave it as a "shipped" trophy. Long-form release
notes live in `QRCallBox/public/extension/releases.json`.

**Last reviewed:** 2026-06-02.

---

## In-flight

### 1. AurorBuddy backend migration (shanesmith → suite)

**Why:** The shipped shanesmith extension's Firestore writer treated `suspectTotalValue` (Auror cross-store aggregate proxy) as the per-event "$ value." Dashboard's "Dollar impact tagged" was rolling that proxy. Corrected schema separates `transactionTotalCandidate` from `finalEventValue` with explicit confidence labels.

**Where it stands:** Phases 1.1 (rules + indexes) and 1.2 (dashboard back-compat) deployed 2026-06-07. Suite-side writer code complete in `unified-extension-suite/modules/aurorbuddy/lib/{firestore,workflow_status,usage_metrics}.js` + Mark Submitted UI in `view.js`. New SW handlers: `create_event` (workflow lifecycle wired), `mark_event_submitted`, `list_awaiting_final_value`, `record_scan_complete`, `probe_auror_event_value_scrape`. 72h cleanup alarm registered.

**Next concrete step:** Phase 2 — build + distribute the suite extension to one or two analysts as the first real-world test. Verify `tool_workflows` + new-shape `tool_events` + `tool_metric_events` rows land cleanly and dashboard renders both legacy and new shapes in parallel. Once stable for ~2 weeks, advance to Phase 3 (shanesmith sunset).

**Read first:** `BACKEND_OVERVIEW.md` for orientation + the per-phase docs.

### 2. Live Dashboard — Phase 2 sources (compliance + accident + register)

**Why:** The Live Dashboard module (`modules/livedashboard/`, v0.1.0) shipped
2026-06-02 with CVP and Absences live. Three placeholder widgets remain:
Compliance, Accident Evidence, Register Long/Short. Discovery package in
[`live_dashboard_backend/`](live_dashboard_backend/) is the authoritative
spec.

**Where it stands:**
- **Compliance (B):** endpoint mapped, capture-and-replay pattern decided.
  See [`../dev/ENVIANCE_FINDINGS.md`](../dev/ENVIANCE_FINDINGS.md). Needs:
  (1) `https://go.enviance.com/*` host_permission added to manifest.json,
  (2) MAIN-world content script `modules/livedashboard/content/enviance_capture.js`
  (mirror of digitallocks pattern), (3) `pull_compliance` SW handler that
  replays captured `<panel>__WfAdapt.getWfs` request from SW with
  `credentials: "include"`.
- **Accident Evidence (C):** probe inconclusive. See
  [`../dev/ACCIDENT_EVIDENCE_FINDINGS.md`](../dev/ACCIDENT_EVIDENCE_FINDINGS.md).
  Needs probe v2 with iframe detection + longer wait window.
- **Register Long/Short (E):** no probe yet. V1 path (XLSX import) can
  start without one; V1.5 (capture-and-replay) needs the register report
  open + query signature identification.

**Next concrete step:** wire compliance via capture-and-replay (cheapest
of the three since the probe already proved the endpoint). Then accident
probe v2. Then register V1 XLSX import.

### 3. Hoops Sell-Through → ClaimsDisposition

**Why:** Shane wants to surface stores that CVP merch and then immediately
dispose it (high disposal + low sell-through). Hoops has the per-store
Sell-Through number; ClaimsDisposition already has the per-store disposal
data. Combining them creates the signal.

**Where it stands:** endpoint probe complete; query + field semantics
captured in [`../dev/HOOPS_FINDINGS.md`](../dev/HOOPS_FINDINGS.md).
Real data successfully pulled from `api.hoops.wal-mart.com/report-hub/v1/graphql`
for Market 120, week 26.

**Open questions before integration:**
1. Cross-origin cookie behavior — does a direct `fetch` from
   `chrome-extension://...` to `api.hoops.wal-mart.com` with
   `credentials: "include"` carry the SSO cookies? If SameSite=Lax blocks
   them, route via `chrome.scripting.executeScript` into a `hoops.wal-mart.com`
   tab (mirroring Workvivo pattern).
2. Walmart fiscal-week computation — need a small helper to convert
   `new Date()` → `wmWeekNbr`. The dashboard currently passes `26` for
   2026-06-02.
3. Default `deptGroupNbr` — `2` (all merch) for the headline; drill-down
   later.

**Next concrete step:** add SW handler `claimsdisposition.pullCvpPerformance`
that pulls one week's data for all 10 stores in one GraphQL call. Cache to
`chrome.storage.local["claimsdisposition.cvpByStore.<week>"]` (~2 KB). Add
**"Sell Through"** column to Store Comparison table (green ≥ 25%, amber
15–25%, red < 15%). Add R10 outlier rule:
`sellThrough < 15% AND cvpTotalQty >= 100` → at least Medium severity.

**Note on CVP scales (2026-06-02):** The Live Dashboard's CVP source uses
a DIFFERENT Hoops endpoint (tRPC, per-store, `cvpSellThruPct_Ty454` field
which reports ~55–60%) than ClaimsDisposition's planned GraphQL source
(market-level, ratio-derived, ~10–18%). These are two different metrics —
do NOT conflate the threshold bands. ClaimsDisposition keeps 25/15;
livedashboard uses 55/45. See `dev/HOOPS_PERSTORE_FINDINGS.md`.

---

### 4. DigitalLocks V1.5 — Power BI automated ingest

**Why:** V1 ships manual-import-only (drag-drop Power BI XLSX export). V1.5
lets the reviewer type a store number and click Search; the SW drives the
Power BI report directly.

**Where it stands:** spec written in
[`DIGITAL_LOCKS_MODULE.md`](DIGITAL_LOCKS_MODULE.md) section "A. Automated".
V1 manual-import pipeline is shipped — V1.5 just feeds bytes into the same
parser/scorer/persistence path.

**Open questions:** none blocking. Defaults are sane.
See [`DIGITAL_LOCKS_QUESTIONS.md`](DIGITAL_LOCKS_QUESTIONS.md) for the full
non-blocker list.

**Next concrete step:** create `modules/digitallocks/content/powerbi_driver.js`,
declare it in top-level `manifest.json`, add `app.powerbi.com/*` host
permission, add `digitallocks.pullPowerBiExport` SW handler that:
1. opens/finds a background `app.powerbi.com` tab on the report,
2. injects the driver,
3. drives the slicer to the requested store,
4. triggers Export → Excel,
5. captures the .xlsx via `chrome.downloads.onCreated`,
6. returns bytes base64.

---

### 5. ClaimsBuddy — finish + re-enable

**Why:** Clearsight claims helper (storms-package wrapper). Has content
script and native messaging host already in `modules/claimsbuddy/`.

**Where it stands:** disabled in `modules/_registry.js` — both the import
line and the array entry are commented out. Code is on disk;
`modules/claimsbuddy/content/clearsight_content.js` is still declared in
top-level `manifest.json::content_scripts` (intentional — the host page
expects the install-guard probe).

**Next concrete step:** decide the remaining QA gates. When ready, uncomment
both lines in `modules/_registry.js`.

---

### 6. VizPick Market Rollup — remaining UI + caching work

**Why:** `modules/vizpick/` (v0.1.0, alpha) replaces typing store numbers
one at a time into Tableau's VizPick Details search box. Pick a market once,
see every store in it side by side.

**Where it stands:** capture pipeline is working end-to-end against real
Tableau data. Confirmed 2026-08-16: Market 1 returned 11 stores, market
gauges rendered, store cards expanded.

**Why the export exists at all (settled live 2026-08-21).** The viz is
`renderMode: "render-mode-server"` — Tableau rasterises on the server and ships
an image, so the numbers never reach the browser as data. `dataDictionary` in
the bootstrap payload is `{}`. The crosstab export is the only route by which
values cross the wire; "just parse the vizql render data" is a dead end. But
the export is currently driven through the DOM when it is really three plain
HTTP steps, which is a live optimisation worth measuring. Full evidence and the
replay sequence: [`../dev/VIZPICK_EXPORT_FINDINGS.md`](../dev/VIZPICK_EXPORT_FINDINGS.md).

Load-bearing details that are easy to break — read before touching capture:
- Tableau does **not** deliver the crosstab CSV over fetch/XHR. It builds
  the CSV client-side into a Blob, calls `URL.createObjectURL()`, and clicks
  a synthetic `<a download>`. `content/tableau_capture.js` patches
  `createObjectURL` and reads the Blob in-page, before it ever becomes a
  file — which also sidesteps Forcepoint DLP quarantining the download.
- The string `Cases Seen %` also appears in Tableau's internal layout /
  session JSON, so the generic `findBySubstr()` false-matches metadata.
  `vizpick_stores_tableau.js` must keep using `findBlobBySubstr()`
  (`via === "blob"` only).
- Do **not** swap the structured CSV capture for screenshots or cropped
  dashboard images. Filtering, math, colour coding, caching and clickable
  cards all depend on real fields.
- Market defaulting reads Settings → Defaults via `getUserHomeMarket()` /
  `onUserMarketChange()` from `shared/userStore.js`. A manual pick must stay
  sticky (`marketIsUserSet`).
- The user's own store card is marked `.is-home` (accent spine + tint +
  "yours" chip) from `getUserHomeStore()`. Compared **numerically** —
  `getUserHomeStore()` strips leading zeros from the WIN suffix while the
  Tableau `Store` column is passed through verbatim, so `"01458" === "1458"`
  would be false. Read once at mount: there is no `onUserStoreChange`, and
  changing the value means a trip to Settings, which unmounts the view.

**Source layout — established live 2026-08-16, don't re-derive it.**
The workbook splits the data across two views with *different shapes*:

| | `views/VizPick/VizPick` | `views/VizPick/VizPickDetails` |
|---|---|---|
| Period | "refreshed daily for the day prior" | "refreshed frequently for the current business day… 1-2 Hours behind" |
| Scope | **all stores, all markets** in one crosstab | **one store**, chosen by a Tableau *parameter* (`aria-label="Store"`, commit with ENTER) |
| Store rollup sheet | "Download Summary by Store" (17 cols) | "Download Department Breakout (Current Day)", `Total` row |
| "Last update" sheet | `8/16/2026` — **date only** | `2026-08-16 10:26:07` — **full timestamp** |

The summary view's date filter offers only `1. Yesterday`, `2. Week to Date`,
`3. Last WM Week`, `4. Last 7 Days`, `5. Last 30 Days` — there is **no Today
bucket and no way to ask it for a single prior day**. That settles the
open question in the original brief:

> **Decision — Yesterday is not obtained by driving the period filter, and
> "previous day" is not obtained by rolling a Today snapshot forward.**
> Yesterday comes straight from the summary view (its native period), and
> Today comes from the Details view. The two are different sources, not two
> settings of one source. History is preserved by keeping the snapshot the
> summary view displaces (`previous`), keyed on Tableau's own update stamp.

Because Today is one export *per store*, a whole market costs N export
cycles. Any market is loaded on the explicit "Load today's data" button.
**One market is also followed automatically (2026-08-20):** the home market
from Settings → Defaults. `service.js::autoCheck` reads it with
`getUserHomeMarket()` on the 30-minute `vizpick.autocheck` alarm and on SW
boot, and **skips entirely when no home market is set** — naming a market
there is the opt-in, which is why `AUTO_DEFAULTS.today` can default to
`true` without crawling a market nobody asked for. Each run still checks
Tableau's stamp first and returns `unchanged` without re-exporting.

Two things this broke on first contact, both fixed 2026-08-20 — worth knowing
because the same shape will recur for any module that starts doing background
work it previously only did on demand:

- **The card grid rebuilt itself every few seconds.** `today_rows` broadcasts
  once per store and the view's handler called `paint()`, which rebuilds the
  grid through `innerHTML` and resets scroll. That was fine while a crawl only
  ever ran because the user pressed "Load today's data" and was watching a
  progress bar; once the crawl also ran unprompted it yanked the page out from
  under anyone reading it, every ~6s for two minutes. The handler is now
  debounced (`ROWS_REPAINT_DEBOUNCE_MS`) so a whole crawl produces one repaint.
  The progress bar and run note stay undebounced — they are cheap text writes
  that do not touch the grid, so the crawl still reads as live.
- **`BOOTSTRAP_MIN_GAP_MS` silently became the refresh cadence.** It was 10
  minutes, chosen when `bootstrapIfNeeded()` only ran as the shell mounted the
  module. Running it at SW boot means it runs on essentially every message, so
  the 10-minute gap overrode `AUTO_PERIOD_MIN` and crawled three times as often
  as intended. It is now pinned to `AUTO_PERIOD_MIN`; two constants controlling
  one rate must not be free to disagree.

Known trade-off: the auto run follows the *home* market, not the last one
crawled by hand. Loading Today for a peer market and leaving the module open
means the next auto run replaces `store.today` with the home market's rows.
The peer market's Today tab then renders empty rather than wrong —
`view.js::todayRows()` inner-joins today rows against the selected market's
roster — but the data is gone until re-loaded.

**Why Today is so much more fragile than Yesterday.** Yesterday is *one*
export from a view that needs no interaction: open tab → wait for the viz →
one crosstab → done (~8s on a warm tab). Today, per store, must type into a
Tableau parameter, wait for the viz to re-query, export sheet A, wait for the
toolbar to come back after the dialog tears down, then export sheet B. For a
10-store market that is ~21 export cycles and ~10 parameter drives against
Tableau's React UI, each with its own timing window — versus Yesterday's one.
The per-step failure rate isn't higher; there are just ~30× more steps.

**Parallel lanes (2026-08-16).** The crawl runs across up to
`MAX_TABS = 3` background tabs draining a shared queue by index (not static
slices, so a lane that draws a slow store doesn't strand the others).
Measured with `dev/test-vizpick-lanes.mjs` against live Tableau, market 323:

| stores | 1 lane | 3 lanes | |
|---|---|---|---|
| 3 | 73.8s | 55.8s | 1.32× — startup-dominated |
| 6 | 218.7s | 77.1s | **2.84×**, 6/6 captured |

At a real market size (9–11 stores) that is roughly 2 minutes instead of 6.

Two bugs this work uncovered, both of which were also hurting the serial
crawl:
- **The toolbar is not a readiness signal for this view.** Tableau paints the
  download button *before* the parameter controls render. The serial crawl
  only got away with driving the Store box immediately because the
  source-stamp export runs first and buys ~20s of slack; the moment extra
  lanes skipped that, 2 of 3 stores died with "no Store parameter input in
  this frame". `prepareTab()` now waits for the Store control itself, and the
  SESSION error names the stage that failed instead of always blaming SSO.
- **A no-op parameter set fires no query.** Setting Store to the value it
  already holds produces no vizql traffic, so waiting for a re-query burned
  the full 25s timeout and then discarded a store whose data was on screen
  the whole time. This killed the *first* store of every crawl whenever the
  view's default matched it. `captureStore()` now skips the wait when
  `set.before` already equals the requested store.

`onStore` persistence is serialised behind a promise chain: `mergeToday` is a
read-modify-write on `chrome.storage.local`, so concurrent lanes would each
read the same snapshot and the later write would silently drop the earlier
lane's row. The lanes stay parallel; only the persist is one-at-a-time.

**Field definitions — verified, and one of them refutes the obvious guess.**
The Details export exposes the real numerators/denominators:
- `Cases Seen % = Cases Seen / Cases Expected` (5,953/10,816 = 55% ✓)
- `Pick % = Suggested Picks Completed / Suggested Picks` (343/739 = 46% ✓)
- `Pallets % = pallets_seen / pallets_expected` (282/294 = 95.92% ✓)

**VizPick Health is mean attainment, not a mean.** Established 2026-08-16
over the full stored roster (4,598 stores). It is *not* an average of the
four component rings — store 1 scores 98.14 with a best component of 98, so
the composite exceeds `max(components)` and no mean, weighted or not, can
produce it. A least-squares fit of the four raw percentages was poor
(max error 8.9pp) and extrapolated above 100, which gave away the real shape:

```
VizPick Health = mean( min(100, cases/95), min(100, location/95),
                       min(100, pick/90),  min(100, overstock/90) ) × 100
```

median error 0.28pp, p95 1.74pp — the residual is the components being
published rounded to whole percents while Tableau computes from unrounded
values. **Therefore the composite's goal is 100, by construction**, not an
invented threshold: a store at or above every component goal scores exactly
100, and 809 of the 4,598 stores do. `GOALS.vizpick = 100` in `view.js`, and
three tests in `parse_vizpick_stores_csv.test.mjs` pin the derivation.

So **`Total Picked` is NOT the Pick % numerator** — in the same row it reads
452 against a numerator of 343. Deriving a denominator as
`Total Picked / (Pick % / 100)` yields 982 against a true 739, a 33% error.
(It counts a wider set of pick categories; it is no longer rendered at all —
see the `Total Picked` entry in the Watch list for why.)
The UI therefore renders only *real* `x / y` pairs and never a derived one;
`modules/vizpick/lib/tests/parse_vizpick_stores_csv.test.mjs` has a test that
fails if anyone reintroduces the derivation.

**Shipped 2026-08-16** — all six items from the original brief are done and
verified end-to-end in the Edge debug profile against live Tableau data
(Market 120, 10 stores):
cards expanded by default with per-card collapse and a Collapse/Expand all;
full-width responsive grid (5 columns × 1552px at 1920px wide, achieved by
opting this module out of the shell's 1400px cap); orange/red highlighting
confirmed rendering `#D97706` / `#B91C1C`; absolute source timestamp with
relative age as secondary; Yesterday/Today tabs each labelled with the
calendar date they describe; real `x / y` ratios.

**Gotcha — `chrome.tabs.query` cannot see Tableau's view name.** Tableau is a
hash-router: the view lives entirely in the URL *fragment*
(`…/#/site/OnlineGrocery/views/VizPick/VizPick`), and match patterns are
matched against the URL **without** its fragment. So `".../*VizPick*"` matched
*nothing* — verified live — which silently disabled tab reuse and made every
Refresh open a new tab and pay a cold render (the usual cause of the `SESSION`
timeout). Both sources now query the host (`".../*"`) and disambiguate the
view with a regex in JS. Reuse of an already-rendered tab takes a capture from
~60s to ~8s, and a pre-existing user tab is never closed.

**Colour is goal-relative, and the current day is deliberately not judged.**
Matching the Tableau dashboard's own rings and Shane's reporting convention
(`lib/charts.js::bandFor`):

| | Yesterday (closed day) | Today (still accumulating) |
|---|---|---|
| at/above goal | blue | blue |
| within 5 pts below | orange | **black** |
| 5+ pts below | black | black |

Being under goal at 11am is meaningless, so a current-day miss is never
coloured as a near-miss. Goals are Cases 95, Locations 95, Picks 90,
Overstock 90; `Pallets %` and the `VizPick` composite have no
published goal and are therefore never judged — the composite ring stays
neutral blue exactly as Tableau renders it. One scale drives both the rings
and the card text so they cannot disagree, and it bands the ROUNDED value
because every surface prints whole percents (banding raw let 95.4 show as
"95" while being coloured as though above 95).

**Refreshing checks the timestamp before doing any work.** Both captures read
the cheap "Last update" sheet first and, if it matches what is already stored,
return `unchanged: true` without exporting anything — the stored snapshot and
its previous-day history are left completely untouched. For Today this skips a
multi-minute per-store crawl (measured 3s instead of minutes); the stored
market must also match, since a different market needs different stores
regardless of freshness. A "Re-capture anyway" link appears after a skip.

**Known gaps / next steps:**
- Today needs TWO exports per store: the department breakout (picks/cases +
  the raw ratios) and "VizPick Donut Health" (Location %, Overstock % and the
  composite — the breakout has none of those). Between them the viz toolbar is
  removed from the DOM while the first dialog tears down, so the second export
  must wait for it to reappear or it silently finds no Download button.
- The Today crawl reuses one Tableau tab and sets the Store parameter in a
  loop. It waits for a fresh vizql response (via the capture ring) before
  each export, which is what stops it exporting the *previous* store's
  numbers — the one failure mode that would look like valid data. Worth
  re-checking if Tableau changes its request pattern.
- Today is captured for the market that was selected when the button was
  pressed; switching market does not invalidate it (the snapshot records
  `market`, and `todayIsCurrent()` compares it), but there is no automatic
  re-pull on market switch.
- No alarm/scheduled pull yet — both captures are manual.

**Testing notes:** Edge does not hot-reload extension source — reload at
`edge://extensions` and close stale Tableau tabs so a fresh content script
is injected. `dev/test-vizpick-e2e.mjs` does both automatically and drives
the whole UI (`--today` also runs the per-store crawl);
`dev/test-vizpick-cache.mjs` verifies the snapshot roll rules against the
live extension. The Playwright/CDP debug profile is a separate Edge profile
from the user's normal window. A one-off `SESSION` render timeout resolved on
retry; don't add speculative focus-management complexity unless it repeats.

---

### 7. Periodic alarms — suite-wide fix, landed 2026-08-20

**What was wrong:** six modules had alarms that could never fire. Two
compounding bugs:
1. `chrome.alarms.create()` with an existing name **cancels and reschedules**
   it, restarting the period from zero. Several modules called it
   unconditionally under a comment asserting the opposite ("Idempotent —
   replaces any prior entry"). Replacing *is* the bug.
2. Those installs ran from `module.js::register()`, which `app.js` calls when
   the shell mounts a module and the service worker never calls at all — so
   the alarm was (re)created on every shell page load and nowhere else.

Together: open or reload the suite tab more often than the alarm period and
the alarm never fires. `digitallocks` was the worst case at 24 hours.

**What landed:** `shared/alarms.js` (`ensureAlarm()` + `IS_SERVICE_WORKER`),
covered by `shared/tests/alarms.test.mjs`. Installs moved to `module.js` top
level behind the SW guard. The rules are now in
`MODULE_CONTRACT.md::Periodic alarms` — read that before adding a module with
an alarm.

| Module | Had period-reset bug | Ungated `onAlarm` |
|---|---|---|
| `vizpick` | ✅ fixed | ✅ fixed |
| `digitallocks` | ✅ fixed | ✅ fixed |
| `workvivo` | ✅ fixed | ✅ fixed |
| `livedashboard` | ✅ fixed | ✅ fixed |
| `sparkscango` | ✅ fixed | ✅ fixed |
| `sparkfraud` | ✅ fixed | ✅ fixed |
| `metricshot` | no — already read-before-create | ✅ fixed |
| `aurorbuddy` (×3) | no — already read-before-create | ✅ fixed |
| shell updater | no — already correct | n/a (SW-only file) |

**Not folded in, deliberately:** `livedashboard`'s `bootstrapIfNeeded()` stays
in `register()`. Unlike the alarms it is a dashboard-*open* behaviour and its
pulls drive Hoops/IVR pages; moving it to SW boot would run those on every
browser start whether or not anyone opens the dashboard. `vizpick`'s
equivalent *was* moved, because keeping the current-day rollup warm without
being viewed is the entire point of that module.

**Still worth verifying in the wild:** these alarms have effectively never
run, so their handlers are the least-exercised code in the suite. Watch the
first few ticks of `sparkfraud`'s watchlist poll and `sparkscango`'s
15-minute exception pulls.

## Watch list (not in flight; would be picked up next)

- **VizPick `Total Picked` — resolved and removed from the card (2026-08-20).**
  It counts a WIDER set of picks than `Pick %` does. The VizPickDetails
  Picks-ring hover itemises the categories: `On Hand Picks Today` (= the
  export's `Suggested Picks Completed`, and the only category `Pick %` is
  computed from), plus `Pick Anyway Picks`, `Clearance Picks` and
  `Modular Deleted Picks`. `Pick Anyway` is the decisive one — a named class of
  picks the system did not suggest. Same unit throughout; picks are picks. That
  is why the card showed 173/568 next to 278 and read as a contradiction.

  Not fully decomposed, and now moot: on the sampled store 411 + 182 + 3 + 7 =
  603 while the tooltip's `Total Picks` read 711, so at least one category is
  unlisted ("Additional Information" is a selection, not a breakdown). It was
  also never confirmed that the tooltip's `Total Picks` is the same measure as
  the export's `Total Picked` column.

  **Decision: completed / suggested is the number that matters.** The
  `Total Picked` row is gone from the store card; `Pick %` already shows the
  real ratio (e.g. `173 / 568  30%`). The field is still parsed — it is a
  column in the export and costs nothing — it just has no UI. The
  investigation scaffolding built to define it (`lib/pick_semantics.js`, its
  tests, the retained per-department rows, the `pickSemantics` diagnostics
  block and its storage key) has been removed rather than left as dead weight
  for a metric nobody uses.

  If a `Total Picked` row is ever re-added it needs a definition first, and
  the open question above is what to answer.

  *Housekeeping:* a `vizpick.debug.pickSemantics` key may linger in
  `chrome.storage.local` on profiles that ran the instrumented build. Nothing
  reads it, it is bounded at a few tens of KB, and the suite has
  `unlimitedStorage` — harmless to leave.

- **DigitalLocks `NEW_HIRE_CONTEXT` — dead config, needs a hire-date source.**
  `data/risk_weights.json` carries `NEW_HIRE_CONTEXT: 10` and
  `thresholds.newHireThresholdDays: 90`, but no rule in
  `lib/riskScoring.js` reads either — they have never fired. The intent is
  to add weight when the associate opening the lock is inside their first
  90 days.

  **Blocker:** the Power BI export has no hire date. Its columns are
  `store, Lock name, Zone Name, Unlock Source, USER ID, FIRST NAME,
  LAST NAME, Position, Event_time` — nothing tenure-related. So this needs
  a second source keyed on `USER ID` (WIN). Options, cheapest first:
  1. Derive a *proxy* from the import itself — first-seen date per WIN
     across stored imports. Free, no new source, but only as deep as the
     retained history and it mislabels anyone who simply hadn't opened a
     lock before. Would need to be labelled "new to lock activity", not
     "new hire", or the reason string lies to the reviewer.
  2. A user-maintained roster JSON in `data/` (same pattern as the other
     editable configs) — accurate, but manual upkeep per store.
  3. A real directory/HR lookup. See the dead ends in
     [`../dev/DIRECTORY_FINDINGS.md`](../dev/DIRECTORY_FINDINGS.md); the
     one live lead there is the Workvivo user lookup, which returns
     identity but not tenure.

  Decide the source before writing the rule — the weight is the easy part.
  Until then, leave the two config keys in place (documented as inert)
  rather than deleting them.

- **User-directory lookup for ClaimsDisposition.** Probes in
  [`../dev/DIRECTORY_FINDINGS.md`](../dev/DIRECTORY_FINDINGS.md). Most
  promising lead: `workvivo.walmart.com/users/lookup?username=<u>` — need to
  test with a coworker's username to see whether matched users redirect to
  `/users/<numericId>` (distinguishable from self-redirect to `/`). If that
  works, wire it into `lib/userDirectory.js::_fetchFromDirectory`.
- **`shared/http.js` generalization.** Stub today; modules hand-roll fetch.
  Per `README.md::Shared helper inventory`, generalization waits for a 2nd
  consumer of the AurorBuddy `appriss_http.js` retry/auth-wall pattern.

---

## How to use this file

- Add an entry when you start something new.
- Remove an entry when the work ships. Don't keep "completed" lines here.
- If something gets stalled for > 2 weeks, move it to "Watch list" or kill
  it entirely.
- For tasks that span more than this file describes, link to a per-task doc
  (`docs/<TASKNAME>.md`) or a memory entry.
