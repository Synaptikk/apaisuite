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
