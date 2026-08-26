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

**It CHECKS every 30 min; it does not crawl every 30 min (clarified 2026-08-22).**
The current-day data republishes only every few hours, so nearly every check
exists to discover that nothing changed. That check used to cost a full
crosstab export of the Last-update sheet — the expensive part of the module —
purely to read a timestamp. `readSourceStampFromDom()` now reads the
"Updated <timestamp>" the dashboard already prints in its top right, and falls
back to the sheet export only when the page shows nothing parseable. The
comparison normalises through `parseLastUpdate().iso` rather than comparing raw
strings, because the two sources can spell the same instant differently
("2026-08-22 07:04:54" vs "8/22/2026 7:04:54 AM") and a raw compare would read
that as "changed" on every check and re-crawl forever.

**VizPick emitted no telemetry at all until 2026-08-22.** That is why "the
auto-refresh isn't running" could only be answered by guessing — `autoCheck`
decided something every 30 minutes and left no trace. It now emits
`alarm-fired`, `alarm-ensured`, `bootstrap-skip`, `autocheck-start`,
`autocheck-stores`, `autocheck-today-plan` (with the home market, the resolved
market, and the roster size) and `autocheck-today`. Every branch that ends in
"do nothing" says so, visible in Settings → the hidden debug panel.

**COLUMN RENAME, 2026-08-22 — the actual cause of "Today stopped updating".**
Tableau republished the workbook and renamed two department-breakout columns:

| was | now |
|---|---|
| `Suggested Picks` | `Suggested Picks Seen` |
| `Suggested Picks Completed` | `Suggested Picks Done` |

(with an on-dashboard banner announcing a change to Pick % itself — the
arithmetic is unchanged, `Done / Seen`, verified 54/86 = 63%.)

`parseDeptBreakout` looked both up by exact name, so its required-column guard
rejected every export: all 10 stores failed, the crawl captured nothing, and
the Today tab sat frozen at the last good pull (2026-08-20 21:26) looking
entirely healthy. It now accepts both spellings — a revert must not break us
again, and renaming columns is evidently something this source does.
`lib/tests/dept_headers.test.mjs` pins both, using the header row copied
verbatim from the failing run's diagnostics.

**TODAY CAPTURED NOTHING AT ALL, 2026-08-24 — root-caused and fixed.** The
symptom was a card showing numbers that disagreed with Tableau. It was not a
parsing problem: the capture had been failing outright for every store, and a
failed capture correctly leaves the stored snapshot alone, so the tab kept
serving an old pull and looked healthy.

The crawl was adopting **MetricShot's `:embed=y&:toolbar=n` tab**. That tab
renders the viz perfectly — the Store parameter box is right there — and has no
toolbar; the export is driven through the toolbar's Download button. So
`waitForVizReady` polled 120s for a button that cannot exist, per lane, and the
result was classified `SLOW_RENDER`, whose message ends *"retrying often
works"*. Retrying can never work. Three separate investigations went looking at
Tableau's speed instead of at which tab was adopted.

There WAS a guard (`TOOLBAR_SUPPRESSED`, added in `ccead37`) and it was
correct — but it filtered `chrome.tabs.query` results, and that result is a
snapshot: a tab still loading reports its PRE-REDIRECT url, so the tab passed
the filter and only resolved to `:toolbar=n` afterwards. **A url is not a
usable test for this.** What landed instead:

- `waitForVizReadyOrSuppressed()` decides from the **DOM**: the Store box being
  present proves the viz rendered, so a toolbar still missing after a 20s grace
  is missing by design. Returns `"suppressed"` distinctly from a timeout.
- On suppression the crawl **opens its own tab** rather than failing. Reloading
  cannot help — the tab comes back `:toolbar=n` — and it belongs to another
  module, so it is left untouched.
- New `NO_TOOLBAR` error class, so this can never again read as slowness.
- `modules/vizpick/lib/tests/toolbar_suppressed.test.mjs` (9 tests) pins the url
  forms, the DOM-based detection, the ordering, and the classification.

**Two bugs the tab failure had been masking**, both fixed in the same pass:

- **The donut-health regression (what 0.9.7 was held for).** The HTTP replay
  returns a DIFFERENT SHAPE for that sheet than the dialog does — a two-column
  `VizPick, 93.33…` instead of the five ring columns — and it still contains the
  needle, so `exportSheetText`'s needle check passes it through. Measured: 8 of
  10 stores lost their health rings, and the two that kept them were exactly the
  two that had driven the dialog to learn the sheet ids. The dialog returns the
  right shape, so a failed replay-parse now falls back to it once. **10/10 with
  health**, verified live.
- **Raw floats leaking onto the cards.** The dialog returns Tableau's own
  formatting (`96%`); the replay returns the xlsx cell (`96.3911399243652`).
  Same measure, so a store printed `96%` or `96.3911399243652%` depending only
  on which route it took — 5 of 10 affected. Percentages now round at the parse
  boundary (`pct()`), which is where the DOM route already effectively did. The
  raw numerators/denominators are untouched, so the x/y ratios stay exact.

**`CAPTURE_BUILD` was lying, and that is what cost the most time.** It was a
hand-written `"2026-08-16d"` sitting under a comment promising it "makes the
provenance explicit" — while a week of daily changes shipped under that stamp.
Three times in one session a stale failure record was read as current. It is now
derived from the manifest version (guarded, because the node tests import
`service.js` against a chrome stub with no `getManifest`). **A stamp nobody
remembers to bump is worse than none: it reads as evidence.**

*Testing note that matters:* re-launching Edge with `--load-extension` on a
profile that already has that extension **re-registers it without recompiling**
— `chrome.runtime.getURL` serves fresh source from disk while the worker keeps
executing the cached module graph. Every "verification" run against that profile
was silently testing old code; the truthful build stamp is what exposed it. To
test capture changes for real, load the suite from a **different path** so it
gets a new extension id, or use a fresh `--user-data-dir`.

Verified live 2026-08-24, market 120, with a `:toolbar=n` tab deliberately open:
10 of 10 stores captured, 10 with health, no failures, 134s across 3 lanes.
Store 1458 matched the dashboard exactly on Cases/Locations/Overstock.

**Three things made a one-line breakage take two days to find**, all fixed:
1. VizPick emitted no telemetry, so `autoCheck` decided something every 30
   minutes and left no trace.
2. `pullToday` dropped `result.debug` on the failure path, so even once
   logging existed the per-store reason was invisible.
3. A failed capture correctly leaves the stored snapshot alone — but nothing
   said so, so a frozen tab looked normal. `todayFreshness` already knew and
   was never rendered; the Today bar now warns when the last capture failed or
   the snapshot is stale.

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
| `metricshot` | no — already read-before-create | ✅ fixed | ⚠️ **install site missed — see below** |
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

**metricshot was half-swept, and it cost the module its whole schedule
(found + fixed 2026-08-25).** The sweep checked each module for the two bugs
above; metricshot had neither (it read before creating, and its listener got
the guard), so it was ticked off. But bug 2 has **two** halves — the listener
site *and* the install site — and only the listener was moved. `installTickAlarm()`
stayed in `service.js::register()`, i.e. the shell page.

So the 1-minute tick alarm existed only after someone opened the Metric Shots
page, and Chrome drops every alarm on extension update/reload. Between a reload
and the next visit to that page there was no tick at all, and a metric that
never ticks never posts — scheduled slots simply passed, then aged out of the
60-minute catch-up window. **"Run now" always worked**, which is what made it
read as a Workvivo/destination problem rather than a scheduling one.

Two things made it survive that long:

- The module's own comment asserted the omission was deliberate — *"metricshot's
  alarm is started and stopped by the user's schedule, not installed
  unconditionally"*. Nothing started or stopped it: `clearTickAlarm()` had no
  callers anywhere in the tree. **A comment claiming an omission is intentional
  is not evidence that anything implements the intent.**
- Checking the symptom healed it. The UI's tick-state line does say
  `Tick alarm not scheduled` — but reading it means opening the page, and
  opening the page ran `register()` and installed the alarm. Every look found a
  healthy alarm that had been created by the looking.

What landed: `installTickAlarm()` is called at `module.js` top level under
`IS_SERVICE_WORKER`, matching all seven other alarm-driven modules, and now goes
through `ensureAlarm()` so a drifted period is repaired rather than preserved.
It also emits `alarm-ensured`, so "does the alarm exist" is answerable from the
log instead of by opening the page that fixes it. `ensureSeed()` deliberately
stays in `register()` — seeding from SW boot would start posting to Workvivo for
someone who has never opened the module; an empty metrics list just makes
`tick()` a no-op.

`shared/tests/alarm_install_sites.test.mjs` scans every `modules/*/module.js`
and fails if one registers an alarm listener without installing an alarm beside
it, or puts either outside the guard. It is a source scan on purpose: the thing
that regressed is a call site, and importing each `module.js` to observe the
effect needs a chrome stub wide enough for every transitive import in that
module's `service.js`.

### 8. Source schema watch — landed 2026-08-22, two of ~five sources wired

**Why:** the VizPick column rename broke every current-day capture for two days
and nothing noticed. Our sources are internal dashboards other teams republish
at will, not APIs with contracts, so a shape change is an expected event and
needs to be treated as one.

**What landed:** `shared/schema_watch.js` (pure diff + dedupe, 13 tests),
`shared/schema_watch_report.js` (baseline load, telemetry mirror, upload),
`shared/data/source_schemas.json` (the approved shapes, in git), Firestore
collection `suite_schema_drift`, and the runbook at
[`SOURCE_SCHEMA_WATCH.md`](SOURCE_SCHEMA_WATCH.md). Wired into
`vizpick.deptBreakout` and `vizpick.summaryByStore`.

**Next concrete step — wire the remaining sources.** Each needs a baseline
entry plus one `watchSourceSchema(...)` line at its parse site:
- `digitallocks` — Power BI DAX result columns
- `livedashboard` — Hoops tRPC / CVP field set
- `sparkscango` — Power BI exception + audit pages
- `metricshot` — consumes vizpick's parsers, so it inherits the two above

**Then: alerting.** Detection currently lands in Firestore and the debug panel
and waits to be looked at. A scheduled query filtered to `stillParsed: false`
is what turns this from a record into a warning.

**Known blind spot, worth naming:** this watches column NAMES. A source that
keeps its names and changes a column's *meaning* is invisible to it — and the
same 2026-08-22 republish carried a banner announcing a change to Pick %
itself. Sanity ranges on known-stable ratios would be the next layer, and it is
the layer that catches "parses fine, renders confidently wrong".

### 9. Service-worker keep-alive — landed 2026-08-22, three jobs wrapped

**Why:** "navigating away stops background loading, even a manual one." Not a
cancellation — the MV3 worker is collected after ~30s of no extension-API
activity. While the suite page is open the pending sendResponse channel holds
it up; close or navigate that tab and the job is killed part way through with
nothing logged.

**What landed:** `shared/sw_keepalive.js` (refcounted, 7 tests) plus the rule
in `MODULE_CONTRACT.md`. Wrapped: `vizpick.pullStores`, `vizpick.pullToday`,
`metricshot.runOne`.

**Next concrete step — audit the rest.** Any SW job over ~30s needs it. Likely
candidates: `claimsdisposition` (Looker pulls), `livedashboard` (Hoops/CVP
fan-out), `sparkscango` (Power BI page pulls), `digitallocks` (Power BI DAX +
Workday directory scrapes), `aurorbuddy` (evidence + Firestore batches).

**Note:** vizpick's Today crawl already survived, but only by accident — it
polls `chrome.tabs`/`chrome.scripting` constantly and each call resets the
idle timer. That stops being true the moment the DOM-driven export is replaced
with the direct HTTP replay described in `dev/VIZPICK_EXPORT_FINDINGS.md`,
which is exactly the kind of change that would have quietly reintroduced this.

### 10. VizPick Associates view + export replay — landed 2026-08-22

**Export replay.** `lib/sources/tableau_export_replay.js` replaces the
Download → Crosstab dialog with the two HTTP calls it really is:
`POST export-crosstab-to-excel-server` then `GET` the resultKey. Measured live:
846 ms for a small sheet, 1.52 s for the 36 KB location sheet, against ~12.6 s
of lane time per store through the DOM. `sheetdocId` is learned from the first
DOM export of each sheet (the content script already records `reqBody`) and is
stable across sessions — verified by replaying a GUID captured the previous day.
Full evidence: [`../dev/VIZPICK_EXPORT_FINDINGS.md`](../dev/VIZPICK_EXPORT_FINDINGS.md).

Two things only the live run caught, both of which would have shipped:
the download lives under `/tempfile/sessions/` (the plain path 404s with an
HTML body the parser would have been handed), and the xlsx stores percentages
as **fractions** where the CSV gave formatted text — left alone it parsed
perfectly and rendered every card at 0%.

**Four exports per store now**, affordable only because of the replay:
dept breakout, donut health, department groups, location details.

**Department groups** are captured rather than derived. metricshot computed
Fresh/F&C/GM locally from the breakout, which only carries Cases % and Pick % —
70% of Tableau's weighting. Same store, same moment: local 57.9/8.2/0.05 against
Tableau's 66/28/20. The local path stays as a fallback (the export is soft), and
`deptGroups` is null rather than [] so the two cases are distinguishable.

**Associates view.** Department | Associates tabs on each store card. Lists who
left suggested picks behind, worst first, capped at `TOP_ASSOCIATES` (10) per
store, expandable to the bins. Attribution is an INFERENCE — picks are assigned
to locations at 9am, never to people, and `win` is whoever last scanned the bin
— so every bin row carries its scan time, because a late scan is exactly where
that inference breaks. Bins nobody scanned are listed separately: work not
started is a different problem from work left behind.

**Associate lookup consolidated.** `shared/associateLookup.js` now owns both
resolution paths (Workvivo → name, Workday → title + tenure), promoted out of
claimsdisposition and digitallocks; the assocpurchases near-duplicate is
deleted. `associateDirectory.js` remains the permanent store and knows nothing
about lookups. Do not add a fourth copy of either.

Costs, measured: ~52 distinct scanners per store, so 300-500 per market before
the cap.

**Job titles are NOT fetched by this view (decided 2026-08-22).** Workday needs
its own tab and a DOM scrape per WIN, serial because they share that tab —
minutes of background work to decorate a list already readable from names. A
title still renders when the directory holds one, which happens as a side
effect of digitallocks resolving an associate a reviewer actually opened.
`shared/associateLookup.js::lookupTitle` remains for that user-initiated path.
If titles are ever wanted here, the cheap route is a bulk source, not a
per-WIN scrape.

**Still unexplained: the stamp.** A check reported `unchanged` against a stored
key of 09:10:21 while a freshly loaded session reported 10:04:03, and reloading
the reused tab did not shift it. Three hypotheses were tested and none held. The
symptom is bounded rather than fixed: `MAX_TODAY_AGE_MS` (90 min) crawls
regardless of the stamp, and `autocheck-today` now logs `stampRead` /
`stampKnown` / `storedAgeMin` so the next occurrence is one line to diagnose.
Confirmed working 2026-08-22. **Do not remove the ceiling before the root cause
is understood** — it is the only thing preventing a silent permanent stall.

**The export replay never engaged — fixed 2026-08-22.** A live run reported
`replay: { haveContext: true, sheetsLearned: 0, replayed: 0, fellBack: 0 }` and
took 149.9 s for ten stores, i.e. every store paid the ~12 s DOM route while
the fast path sat there looking healthy. Cause was a closed loop:
`learnSheetIds` reads the `sheetdocId` GUID out of a captured request body, but
`content/tableau_capture.js` recorded only `string` and `URLSearchParams`
bodies — and Tableau's own export posts **multipart FormData**, so that request
landed in the ring with `reqBody: null`. The only bodies ever captured were the
replay's own, which it could not send until it had already learned a GUID.
`serializeBody()` now handles FormData (and both the fetch and XHR patches use
it), emitting the same multipart shape `learnSheetIds` already parses. The two
producers meet in one test — `export_replay.test.mjs::"learns from a body
captured off Tableau's OWN export"`. **Watch `sheetsLearned` on the next live
run**: it should be non-zero after the first store, and per-store time should
drop from ~12 s to ~1–2 s.

Two follow-ups from tracing that chain end to end (2026-08-22):

- **Learning ran only on the success path.** `exportSheetText` bailed on
  `no CSV captured` *before* calling `learnFromRing`, but the GUID comes from
  the export command the page has already posted — which fires whether or not
  a file ever comes back. So a failing store taught the crawl nothing, and the
  next store paid the same slow dialog and could fail the same way. Learning
  now happens before the bail.
- **`no CSV captured` was a dead-end message.** It cannot distinguish the
  driver never posting the command (a selector/timing bug), the server
  rejecting it, the file never arriving (a slow store — the only case where
  raising `EXPORT_WAIT_MS` helps), or a file arriving that did not contain the
  needle (usually a store with no rows, or a renamed column). The ring holds
  all four. `summariseExportAttempt(ring, needle)` in
  `tableau_export_replay.js` reads it out and the reason string now carries it.
  Blob captures have no filename — the download name lives on the synthetic
  `<a>`, not the Blob — so arrived-but-unmatched files are identified by their
  **header row**, which is also the only line safe to log (column names, never
  anyone's data).

**Store 5173 is not yet root-caused.** It failed one of its four sheets on the
2026-08-22 run (`partial: true`, 9 of 10 stores) with the old bare message, so
there is nothing to diagnose from retrospectively. The next occurrence will say
which of the four cases it is.

Related, not merged: `modules/metricshot/lib/sources/vizpick_export.js` is a
second, older implementation of this same export with two sheetdocId GUIDs
hardcoded. It would make a reasonable seed for the learner (removing the
first-run cost entirely), but the two were written independently and
reconciling them is its own job.

**0.9.7 is HELD, on the analyst's call 2026-08-23.** Live stays on **0.9.6**.

Why: live 0.9.6 predates the `isExportCommand` fix, so the replay has never
engaged on it. It is slow and drops some stores, but its data is correct.
Shipping this branch would turn the replay on for every user, and that is the
change the donut-health regression rode in on. **Do not release until the
donut bug below is root-caused.**

Everything else on the branch is wanted and ready — the export driver (10/10
instead of 6/10), real names on printouts, the print dialog opening at all,
the theme flash, the honest banner. None of them depend on the replay, so if
the donut bug proves slow to solve, shipping with the replay defaulted OFF is
the fallback.

**Release notes, already authored — use verbatim when it does ship:**

> • VizPick Today now captures every store in the market — exports were
>   silently stalling on roughly four stores in ten.
> • Printed reports show associate names instead of IDs, and the print dialog
>   now actually opens.
> • Fixed a flash of light theme on every open for dark-mode users.
> • The capture banner no longer claims stores are missing when they are not.

Release mechanics for whoever picks this up: `QRCALLBOX_DIR` must be passed
explicitly — `release.sh` defaults to `../../QRCallBox`, which does not exist;
the repo is at `Desktop/Projects/QRCallBox`. And **check `public/extension/`
holds every previously-published zip before deploying** — it is untracked, so a
checkout that missed a release will silently delete those versions from the
live site. See the 0.9.6 entry.

**OPEN: donut-health export failing for ~80% of stores (2026-08-23).** On
screen this is 8 of 10 cards with no composite ring, no Locations and no
Overstock. Cases Seen and Picks are fine everywhere — those come from the
department breakout; the other three come from the **donut-health** export, so
it is that second export dropping, not the crawl.

Not yet root-caused, and deliberately not guessed at. What is known:
- At 17:47 the donut export succeeded for 5 of the 6 stores that captured.
- It is now failing for 8 of 10, and the change in between is the one that
  first made the **replay actually engage** (`isExportCommand`). That is the
  prime suspect but it is not proof.

**A/B instrument:** set `vizpick.debug.noReplay` to `true` in
`chrome.storage.local` and force a Today refresh. That routes every export
through the DOM dialog. If the rings come back, the replay is the cause; if
they do not, it is not, and the per-store `failures[]` reasons say what is.
`replay: { disabled: true }` appears in the diagnostics when the switch is on,
so a run cannot be misread as a normal one.

Candidates, all unverified: the replayed xlsx not containing `DONUT_CSV_NEEDLE`
("New VizPick") so it falls back and then the toolbar wait fails; a learned
sheetdocId keyed to the wrong sheet; the donut GUID never being learned at all
because the dept export now replays and never opens a dialog to learn from.

**Inline scripts are blocked suite-wide — two fixed, three still broken
(2026-08-23).** `manifest.json` declares no `content_security_policy`, so MV3's
default `script-src 'self'` applies to every extension page. Any inline
`<script>` is blocked and silently does nothing; the only sign is a console
error that reads like noise.

Fixed:
- `app.html`'s theme anti-flash script → `theme_boot.js`. It had **never run**,
  so dark-preference users got a flash of light theme on every single open.
  Loaded as a classic script (not `type="module"`) before the stylesheets —
  modules defer, which would let the sheets paint first and reintroduce the
  flash.
- VizPick's printouts carried `<script>setTimeout(window.print)</script>`. A
  window opened from an extension page inherits the extension's CSP, so it was
  blocked on every print: the report rendered and the dialog never appeared.
  `pageShell()` now emits no script at all and **view.js calls `w.print()`**
  from its own context, where it is allowed.

**Still broken, same cause, not swept:** `modules/orcmonitor/report.js` (:166
print button, :174 auto-print), `modules/sparkfraud/view.js:785`,
`modules/stockingplan/lib/render.js:179`. Every one of those print dialogs
silently never opens. Same fix each time: drop the inline script, print from
the opener.

**Separately, `[push] subscribe failed: no active Service Worker`.**
`ensurePushSubscription()` runs at SW top-level, but `pushManager.subscribe()`
needs the registration to be ACTIVE — a boot race. It degrades correctly (the
polling alarm is the documented fallback) and recovers on a later wake, so it
is noise rather than breakage, but it fires on every cold boot.

**CROSS-STORE CONTAMINATION — introduced and fixed 2026-08-23. Any Today
snapshot captured between the `isExportCommand` fix and this one is SUSPECT and
should be force-re-pulled.**

Symptoms: associate names and bins filed under the wrong store, and health
rings missing on many stores.

Cause: `makeReplayState()` returned a single `ctx`, and one replay state is
shared by all three lanes. `ctx` embeds a **vizql session id belonging to one
tab**, set by whichever lane finished its first DOM export. Lanes 2 and 3 then
called `replayExport(tabId, { base: replay.ctx.base })` — their own tabId, but
another tab's session — so they exported **lane 1's current store's rows** and
labelled them with their own store. The output was perfectly well-formed; there
was nothing in it to show it was wrong.

This was latent for as long as the replay existed and only fired once the
replay actually engaged — i.e. the moment `isExportCommand()` made learning
work. A fix that "turned on" a fast path turned on a data-integrity bug with it.

- `sheetIds` stays shared: sheetdocId GUIDs are **workbook**-scoped, and
  sharing them is the entire point of the learned state.
- `ctx` is now `ctxByTab: Map<tabId, ctx>`; a lane never shares a tab.
- Each context is stamped with its owning `tabId` and `exportSheetText` throws
  on a mismatch. The failure mode was silently-wrong attribution data, so it
  gets an assertion, not a comment.

**Rule for anything added to the replay state: ask whether it is workbook-
scoped or session-scoped.** Workbook-scoped may be shared; session-scoped must
be keyed by tab.

**The driver fix worked — 10 of 10 on 2026-08-23 18:43, no failures.** Per-stage
budgets and the awaited stage machine cleared the 4-in-10 export stalls.
`sheetsLearned` is still unverified: that run short-circuited on an unchanged
stamp (`debug: null`), so it never crawled. **Check `replay.sheetsLearned` on
the next real crawl** — it should be non-zero after the first store, with
per-store time dropping from ~19 s to ~2 s.

**The "some stores could not be captured" banner was lying (fixed 2026-08-23).**
It showed on a complete 10-of-10 capture. Two causes, both now fixed:

1. `partial` was `failures.length > 0`, and `failures` includes **soft** ones.
   Store 5173's donut sheet failed while the store captured fine — a row with
   no health rings, not a missing store. One soft failure made a full capture
   announce that stores were missing. `partial` now means **a requested store
   produced no row**, computed from coverage; soft failures are reported
   separately as `incompleteStores`.
2. The banner read the stored flag, which is a property of the last RUN. A
   later top-up that filled every gap never cleared it. The banner now derives
   from `roster - rows`, so it cannot contradict the cards next to it, and says
   "N missing health rings" when that is the actual condition — a different
   sentence for a different problem.

**Two more root causes found from the 2026-08-23 run (6 of 10 stores).**

1. **`exportDriverFn` lied about success.** It ended `advance(); return { ran:
   true, ok: true, steps }` — kicking off a chain of `setTimeout`s and then
   returning an immediate unconditional success. `triggered.ok` therefore meant
   "a toolbar exists", never "Export was clicked", and `steps.reached`
   serialised back empty because nothing had run yet. When the machine stalled,
   the caller waited out the full 45 s poll and reported the useless "no CSV
   captured". Compounding it, the 24 s tick budget was **shared across all five
   stages**, so a slow first dialog starved every stage after it — a failure
   shape that gets worse with more lanes competing for the same backend, which
   is exactly what 3 lanes × 10 stores produced. The driver is now `async`,
   awaits the stage machine (executeScript awaits a returned promise), budgets
   **12 s per stage**, and names the stage it stalled on. "stalled at sheet
   (never appeared)" and "stalled at export (found but never became ready)"
   have different fixes; both used to read as "no CSV captured".

2. **`learnSheetIds` matched only the xlsx command.** Tableau posts
   `export-crosstab-to-excel-server` **or** `export-crosstab-to-csvserver`
   depending on the radio button — note the asymmetric hyphenation — and
   `exportDriverFn` clicks **CSV**. So every DOM export posted the csv command
   while the learner matched only excel: the one path that exists to teach the
   replay could never teach it. `isExportCommand()` now owns the match and both
   `learnSheetIds` and `summariseExportAttempt` use it. This, not the FormData
   capture gap, is why `sheetsLearned` stayed at 0 — the FormData fix was
   necessary but on its own changed nothing.

**Root cause of the home store showing WINs: "has a record" ≠ "has a name"
(fixed 2026-08-22).** `refreshDirectory()` gated its resolver on whether
`associateDirectory.getMany()` returned anything for a WIN. But digitallocks
writes title/tenure records with **no `name` field** for every associate a
reviewer has opened in Workday — so those WINs looked "known", skipped the
Workvivo lookup entirely, and rendered as bare ids. It presented as one store
being broken (the home store — the only one with prior tool usage; stores the
other tools had never touched resolved fine) and it survived reloads, because
the nameless record lives in `chrome.storage.local`.

`shared/associateDirectory.js::hasName(rec)` now owns that distinction and all
four call sites in the view use it. The mount-scoped "already tried" marker
moved from `directory.set(w, null)` to a separate `attempted` Set — the null
sentinel conflated *tried and failed* with *hold no record*, and clobbered any
title the record did carry. **Gate on `hasName()`, never on `get()`/`getMany()`
returning something.**

**Names resolved and then rendered as ids anyway — two causes, both fixed
2026-08-25.** The symptom was "some associates still show a WIN", which read as
Workvivo missing those people. It was not.

1. **Key mismatch.** `associateDirectory` keys every record by
   `normalizeWin(win)` (trimmed, LOWER-CASED), so `getMany()` returns
   lower-cased keys. The location-details export passes the scanner's WIN
   through verbatim, and those are not all lower case. The view wrote the map
   from `getMany` (normalised) and read it with the raw export value — so a WIN
   with any upper case resolved successfully and printed as an id, with the name
   sitting in the map under a key nobody asked for. The same raw-key read backed
   the "is this resolved?" test, so those WINs also looked permanently
   unresolved to the retry logic and to `nameResolveNote()`. All reads now go
   through `dirGet()`. **This is why it looked like "only some" people —
   it tracked the casing of the scan record, not the person.**
2. **A transient pass was banked as final.** `attempted` was filled from
   `missing` unconditionally, including WINs whose lookup failed only because
   Workvivo had no tab/session yet. Nothing re-queried them for the life of the
   mount, however many refreshes landed behind it. Transient passes now set a
   60s cooldown instead of marking anything attempted, and `source_complete`
   clears `attempted` — a completed capture is the one moment worth re-asking:
   new rows, and time has passed. Definitive misses stay cheap to re-ask
   (associateDirectory answers them from storage for an hour, no network).

Pinned by `modules/vizpick/lib/tests/directory_keys.test.mjs` — a source scan,
because what regresses is a call site inside `mount()`'s closure.

**Bare WINs in the Associates view are now explained, not silent (2026-08-22).**
Rendering an id when name resolution fails is deliberate — better an id than a
confidently wrong name on a list about who is not doing their picks — but three
very different causes all looked identical on screen: Workvivo unreachable, a
standing miss inside the 1 h `MISS_TTL_MS` backoff, and a genuine "no unique
match". `shared/associateLookup.js` now keeps `_diag` counters
(`attempts` / `resolved` / `definitiveMiss` / `transient` / `cachedMiss`),
exported as `lookupDiagnostics()` + `diffLookupDiagnostics()`; the view diffs
them across its pass, emits `vizpick.names_unresolved` to the debug feed, and
prints the applicable cause under the table. Counters are process-lifetime
totals and the shell page and SW keep separate ones — always diff, never read
the absolute.

**metricshot no longer re-pulls VizPick's data (2026-08-22).** Both modules
were exporting the same four Tableau sheets for the same store, in two
sessions, minutes apart — free to disagree about what "now" meant. The ring
values were already shared via `vizpick_snapshot.js`; the two detail sheets
(Location Details, Department Breakout) were not, and were being re-exported
from **four** separate call sites (`capture.js` plus three handlers in
`service.js`).

- `modules/metricshot/lib/sources/followup_data.js::getFollowUpSheets()` is now
  the single path. Order: vizpick's snapshot → headless replay → nothing.
  Fallback is **per sheet** — one missing export must not blank the other.
- `modules/vizpick/lib/ensure_today_store.js::ensureTodayRowForStore()` is the
  single-store door into vizpick's Today pipeline. Fresh row → a storage read
  and no tab at all. Stale (past `DEFAULT_MAX_AGE_MS`, 90 min, matching the
  Today source's own ceiling) → that ONE store is re-captured and written back,
  so the rollup gains from metricshot's schedule instead of racing it.
- `snapshots.upsertTodayRow()` exists because `mergeToday()` stamps the whole
  snapshot with one `capturedAt`. That is honest for a top-up (same run, same
  source stamp) but not for one store re-captured hours later — it would tell
  the rollup every store had just refreshed and suppress the crawl the others
  needed. **Freshness lands on the row**; read it via
  `snapshots.rowCapturedAt(row, today)`.
- `parseLocationDetails(text, { allScans })` now optionally returns `scans` —
  every scanned bin, `{ location, lastSeenAt }` only. metricshot's "Un-scanned
  locations" section ranks all scanned bins by staleness, which is wider than
  `gaps` (bins with picks still outstanding). Collected for the **user's home
  store only**; market-wide it would be thousands of rows a day for a section
  that only ever covers one store. Non-home stores fall back to `gaps`, which
  is narrower but not empty. `scans` is `null` (not `[]`) when not collected,
  so "not asked for" stays distinct from "nothing found".
- **Hours are derived at READ time, never stored.** Staleness grows after
  capture; baking it in at capture would under-report every bin by however long
  the snapshot has been sitting.


**Per-card Print / Pick list / Email (2026-08-22).** Three actions in each
store card's header, faint until the card is hovered (always visible on touch,
where there is no hover). All builders live in `modules/vizpick/lib/card_report.js`
and are pure — view.js only opens the window and hands off the mailto:.

The two printouts are **not the same data in two skins**, and the difference is
the sort:

| | Question it answers | Order | Names |
|---|---|---|---|
| Performance (🖨) | "where is this store losing it, and whose picks are being left" | severity — worst first, everything under goal marked | yes |
| Pick list (📋) | "what do I pull next" | bin group, then location — **walk order** | **no** |

A severity-ranked pull list would send whoever is holding it back and forth
across the backroom, so both orders are pinned by tests.

**The report hung on "Preparing the report…" (fixed 2026-08-23).** Regression
from the fix below: `printCard()` awaits `refreshDirectory()`, which ultimately
awaits `chrome.scripting.executeScript` into a Workvivo tab — and the injected
`_workvivoSearchInTab` did a plain `fetch` with **no timeout**. One stalled
request and that promise never settles, so `lookupName` never settles, so
`lookupNames`' `allSettled` never settles, and every caller waits forever. The
print window had no way out.

Bounded at three levels, deliberately:
- `AbortSignal.timeout(8000)` on the in-page fetch. It sits inside the existing
  `try`, so an engine without `AbortSignal.timeout` degrades to `__err` rather
  than throwing.
- A 12 s race on `executeScript` itself — a discarded or frozen tab leaves it
  pending, which the injected signal cannot rescue because the injected code
  never runs. It **rejects** rather than resolving empty: the caller treats a
  throw as transient and retries, where a definitive "no match" would poison
  the cache for an hour.
- `REPORT_NAME_WAIT_MS` (6 s) in view.js. A report is user-initiated and must
  ALWAYS produce a page; unresolved names print as WINs, the documented
  fallback. This one is the guarantee — the other two are hygiene.

The same unbounded wait was always present in `refreshDirectory()`'s
fire-and-forget call on paint. It simply never surfaced, because nothing was
waiting on it.

**Names on the printout need an injected resolver (fixed 2026-08-22).** The
first release of this printed a column of WINs. `cardAssociates()` rolls up
from the location export, which carries only a WIN; the display name lives in
`shared/associateDirectory.js` and is resolved asynchronously by the view. The
builders were called with the row and nothing else, so `a.name` was never
defined. They now take an `opts.names` WIN → name resolver, and view.js passes
`(win) => directory.get(win)?.name`. Falling back to the WIN stays correct when
a lookup genuinely failed.

Two mechanics that go with it:
- `printCard()` awaits `refreshDirectory()` before building, so a print fired
  seconds after the card appears does not commit ids to paper — unlike the
  screen, a printed page never repaints.
- Because of that await, **the print window is opened synchronously in the
  click handler** and passed in. `window.open()` after an await has lost the
  user gesture and gets blocked as a popup. The placeholder written into it is
  replaced via `document.open()` first — a bare second `write()` appends to the
  still-open stream rather than replacing it.

The pick list is unaffected: it carries no names by design, so it never waits.

**"Bin group" is NOT a department (corrected 2026-08-22).** The leading segment
of a location code — the 002 in 002/003 — is a bin prefix. The bins beginning
002 are "the 002s"; that has nothing to do with department 2. The Location
Details export carries **no department column at all**, so a location cannot be
attributed to a department from this sheet; only the Department Breakout sheet
has real dept numbers, and it has no locations. **The two cannot be joined.**
The parser's field was called `dept`/`byDept` until this was caught, which is
what made the mistake easy to write — so the field was renamed to
`locGroup`/`byLocGroup`, not just the label. Grouping by the prefix is still
correct for a walk sheet (bins sharing a prefix are physically adjacent); only
the word was wrong. `pickList()` still reads a legacy `dept` key as a fallback,
because a stored snapshot outlives the build that wrote it.

Worth noting: `byLocGroup` is computed and stored but **nothing reads it**. It
was intended for a per-department Locations Seen %, which the paragraph above
rules out. It should either find a real consumer under its correct meaning or
be deleted. The pick list carries
no associate names by design: it goes to whoever is pulling now, and who missed
them earlier is a separate conversation on a separate page. Bins with nothing
left to pull are excluded; bins nobody scanned are included (the picks still
need pulling, even though they belong to no associate).

Notes:
- **Provenance is mandatory on both.** `cardStamp()` prefers Tableau's own
  publish time, falls back to capture time, and always says WHICH. A printed
  page outlives the screen — yesterday's numbers read as today's next week.
  It prefers the ROW's `capturedAt` over the snapshot's, since metricshot can
  refresh a single store on its own schedule.
- **Email is a draft, never a send.** `mailto:` hands off to the user's client
  with no recipient; they address and send it.
- **mailto: length.** Windows silently truncates past ~2 KB, so
  `buildCardEmail()` drops whole sections to fit (associates first, then
  departments — the rings always survive) and says it trimmed, rather than
  letting the client cut a sentence in half.
- **Browser print headers.** Chrome/Edge append their own URL/timestamp to
  "Save as PDF" and there is no way to suppress it — the same reason
  claimsdisposition abandoned `window.print()` for pdfmake. These pages are
  designed to read fine with them present. If a header-free PDF is ever
  required here, that means pdfmake, not a print stylesheet.


### 10. Digital Market Rollup — new module, alpha (2026-08-22)

**What it is:** `modules/digitalrollup/` — every store in a market's live OPD
fulfilment health (picking, staging, dispense, availability) in VizPick's
market-rollup layout. Source is the "GIF Market Dashboard", an AI Launchpad
prototype at `ai-innovation-lab-app-bebdeibbicjffabd.walmart.com`.

**The source is an actual API — this is new for us.** It is a FastAPI app and
publishes its own contract: `/openapi.json`, Swagger UI at `/docs`. There is no
crosstab to export, no DOM to drive, no capture ring. What we use:

| Endpoint | Returns |
|---|---|
| `GET /api/dashboard?market=<n>` | the whole rollup — `cards[]` (one per store) + `summary`. ~13 KB. |
| `GET /api/hierarchy` | region/market tree, pre-scoped server-side to the caller |
| `GET /api/region?region=<n>` | **identical card shape one level up** (market cards). Not used yet — a Region tab is close to free. |
| `GET /api/trends?market=<n>` | **broken.** 500 `"Your default credentials were not found"` — the app's server-side GCP ADC is unconfigured. It is the only route to history; until it works, history has to be accumulated locally. |

**Every figure arrives banded.** Each metric ships raw, formatted AND with a
`*_status` of `green|yellow|red|gray` — so unlike VizPick this module invents
no thresholds and computes no bands; it paints what the source decided. That is
a real advantage (our colours cannot drift from the board's) and a real
dependency: losing the `*_status` fields is as breaking as losing a value, and
that is why they are in the schema baseline.

**No rings, deliberately.** The headline figures sit on four different scales —
a percentage, a pick *rate*, minutes, and queue depths. A ring implies a 0–100
fill that most of them do not have, so the ring row is replaced by a headline
strip and the market gauges by stat tiles. Everything else (header, picker,
panel, `auto-fill minmax(300px,1fr)` card grid, home-store spine, show-details
toggle) is VizPick's, on purpose.

**The headline strip is five figures: on-time, pick rate, totes, avg wait,
pre-sub** — workflow order, pick → stage → dispense → availability. Four of
those mirror the board's own top strip; **`totes` is ours.** It is a backlog
rather than a rate, and it *leads* dispense trouble instead of reporting it, so
leaving it behind "Show details" meant seeing it only after the wait time had
already moved. The API bands it (`totes_to_stage_status`), so surfacing it
invents no threshold. Column count comes from `HEADLINE.length` via a CSS
custom property, and the value type dropped to `--fs-sm` — at five columns in
a 300px card, bold `100.0%` beside bold `8.0 min` no longer fits, and those
values are `nowrap`, so they would have overflowed the card rather than wrapped.

**Sorting is generated from the same list.** `lib/sorting.js::METRIC_SORTS`
drives both the comparators and the `<select>`, so a figure cannot appear on a
card without being sortable — 13 options: needs-attention, store ↑↓, and all
five metrics ↑↓. Three things the 12 tests in `lib/tests/sorting.test.mjs` pin:
sorts read the RAW numeric field (`10.0 min` vs `9.5 min` sorts wrong as a
string); missing values sort LAST in *both* directions, because a no-data store
is neither best nor worst; and an unrecognised mode (one persisted by an older
build) falls back to needs-attention rather than leaving the API's own order.

**Totes is shown, not weighted — settled on the analyst's call.** It was
briefly folded into `cardStatus` and into the needs-attention tie-break; both
were reverted. A backlog is context for judging the figures that measure
service, not a verdict on its own, and a store with 159 totes and green
picking/dispense should not be badged as a problem. It also meant inventing a
label — the API bands `totes_to_stage_status` but publishes no `status_label`
for staging — so the chip would have been putting our words in the board's
mouth. So: the card status stays picking + dispense in the board's own
wording, the needs-attention tie-break stays avg wait, and totes has its own
sort for when the backlog is what you are actually looking for. Pinned by
`staging is shown but never weighted into the card's status` in the tests, so
it does not drift back in.

**Auth is the one unresolved thing.** The app sits behind the istio ingress,
which validates a pfedprod SAML JWT off the `AccessToken` cookie.
`lib/gif_api.js` tries a direct SW `fetch` first and falls back to running the
fetch inside a tab on the app's own origin, recording which path won as
`snapshot.via`. **Nobody has yet confirmed which one actually works from a real
profile** — that is the first thing to check on the first sideload, and the
answer also settles the identical open question for Hoops (§3 above).

There is a second gate: the AI Launchpad disclaimer sets `aiilDisclaimerAccepted`
and a profile without it gets bounced to `innovate.walmart.com`. That is
detected and reported as `kind: "DISCLAIMER"` with the fix in the message,
rather than surfacing as a parse error.

**Access scope, verified live:** `/api/diagnostics/headers` resolves the caller
from the JWT and returned `allowed_markets: [120]`. So the market picker will
normally hold exactly one entry — that is correct, not a bug, and the picker
says so instead of looking broken.

**Verification so far:** `lib/tests/normalize.test.mjs` (6 tests, real captured
fixture) passes. `dev/preview-digitalrollup.mjs <fixture.json>` mounts the
real `view.js` against a captured payload and screenshots both themes at three
widths — renders 10 cards / 7 tiles / 1 home card, clean at 900px through
1920px. **Not yet run in a real extension profile**, so the SW pull, the cookie
fallback and the disclaimer path are all untested outside the harness.

**Auto-refresh: every 10 minutes, on by default.** `digitalrollup.autorefresh`,
installed with `ensureAlarm()` from `module.js` top level behind the
`IS_SERVICE_WORKER` guard — the shape §7 mandates. Notes on the choices:

- **10 minutes needs no change-detection.** VizPick checks a timestamp first
  because its capture is a multi-minute crawl. Here one pull is a single
  sub-second call for ~13 KB, so *checking* whether to pull would cost more
  than pulling. There is deliberately no `unchanged` path.
- `BOOTSTRAP_MIN_GAP_MS` is **pinned to `AUTO_PERIOD_MIN`**, not set
  independently. `bootstrapIfNeeded()` runs on essentially every SW wake, so a
  smaller constant there silently becomes the real refresh rate — the bug that
  made VizPick crawl three times as often as intended (§6).
- The `lastAuto` stamp is written **before** the pull, not after. Stamping only
  on success would let a run of failures retry on every SW wake instead of once
  per period.
- Which market it follows: the stored snapshot's, then the home market from
  Settings → Defaults, then the only market your access covers. With no answer
  it logs `auto-start` with `marketFrom: "none"` and does nothing rather than
  guessing.
- `startPull()` is the single owner of the in-flight guard, so a background run
  and a manual Refresh cannot open two anchor tabs at once.
- Telemetry from the start, unlike VizPick: `alarm-fired`, `alarm-ensured`,
  `auto-start`, `auto-skip`, `auto-set`, `bootstrap-skip`, `pull-ok`,
  `pull-failed`. Every branch ending in "do nothing" says so. `diagnostics`
  also reports the live alarm row and its next fire time — a missing row there
  *is* the diagnosis for "the auto-refresh isn't running".
- On/off switch lives in the module header (`Auto · 10m`), not Settings,
  because the freshness pill beside it is where you notice the board has
  stopped moving.

**Next concrete steps:**
1. Sideload and run one real pull; record whether `via` is `direct` or `tab`.
2. If `direct` works, say so in `MEMORY.md` — it contradicts the Workvivo
   precedent and would simplify the Hoops work. It also decides how intrusive
   the 10-minute poll is: `direct` costs one fetch, `tab` opens and closes a
   background tab six times an hour.
3. Watch the first few alarm ticks. Per §7 these handlers are the
   least-exercised code in the suite, and this one has never run in the wild.
4. Consider the Region tab (`/api/region`) — same renderer, one endpoint.

---

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

- **Promote the Workday title/tenure lookup to `shared/`.** The name resolver
  moved to `shared/associateLookup.js` on 2026-08-22 at its third consumer
  (claimsdisposition, assocpurchases, vizpick — the assocpurchases copy was a
  near-duplicate and is deleted). But Workvivo's quick-search returns a NAME
  ONLY. Job title and tenure come from Workday, and that path is still inside
  `modules/digitallocks/service.js::lookupAssociate`.

  Consequence today: vizpick's Associates view shows a job title only for WINs
  digitallocks happens to have resolved already. Everyone else gets a name and
  no title. Moving the Workday path next to the Workvivo one — same file, same
  `Directory.merge()` write — closes that, and is the same three-consumer
  argument.

  Division of labour to preserve when doing it:
  `associateDirectory.js` = the permanent store (knows nothing about lookups);
  `associateLookup.js` = resolution. Do not add a fourth copy of either.
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
