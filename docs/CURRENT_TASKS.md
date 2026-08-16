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

Because Today is one export *per store*, a whole market costs N sequential
export cycles (~10 stores ≈ 4 minutes). It is therefore loaded on an explicit
"Load today's data" button, not automatically.

**Field definitions — verified, and one of them refutes the obvious guess.**
The Details export exposes the real numerators/denominators:
- `Cases Seen % = Cases Seen / Cases Expected` (5,953/10,816 = 55% ✓)
- `Pick % = Suggested Picks Completed / Suggested Picks` (343/739 = 46% ✓)
- `Pallets % = pallets_seen / pallets_expected` (282/294 = 95.92% ✓)

So **`Total Picked` is NOT the Pick % numerator** — in the same row it reads
452 against a numerator of 343. Deriving a denominator as
`Total Picked / (Pick % / 100)` yields 982 against a true 739, a 33% error.
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

**Colour bands are absolute, not goal-relative.** >= 98 green, > 95 Walmart
Spark yellow, > 90 orange, <= 90 red — boundaries belong to the LOWER band.
One scale (`lib/charts.js::bandFor`) drives both the gauge rings and the card
text so they cannot drift. The Tableau goals (95/95/90/90) are still shown as
gauge captions but no longer colour anything. Spark yellow `#ffc220` is used
neat for the rings; as small text on the light theme it only reaches ~1.7:1
contrast, so `--vizpick-caution` darkens the same hue to `#C08A00` there and
uses `#FFC220` unmodified in dark mode.

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

## Watch list (not in flight; would be picked up next)

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
