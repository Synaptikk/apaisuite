# Open Questions

Granular per-source technical questions that need probe sessions to
resolve. Cross-cutting product/policy questions (storeNbr default,
multi-store, polling, etc.) live in the top-level
`docs/LIVE_DASHBOARD_BACKEND_QUESTIONS.md`.

**Last reviewed:** 2026-06-02.

---

## Source A — Absences (IVR ATT Cloud)

**A-Q1.** Should the dashboard subscribe to broadcasts from
`closinglist`, or invoke a fresh scrape on its own poll schedule?

- Subscribe-only: dashboard never costs an extra IVR round-trip; relies on
  closinglist's own usage to trigger pulls.
- Invoke-fresh-on-poll: dashboard triggers `ivr-progress-now` every 15
  min regardless of closinglist user activity.
- **Recommendation: invoke-fresh.** The closinglist module is only used
  during closing-shift work, so subscribe-only would leave the dashboard
  stale most of the day.

**A-Q2.** How should the dashboard handle the case where the user has
disabled the closinglist module?

- Show a configuration-error widget pointing to the registry.
- Inline the scraper logic into livedashboard's own content script.
- **Recommendation: configuration error in V1.** Document the dependency.

**A-Q3.** WIN extraction from the associate string — what formats appear
in production?

- We've assumed `"DOE, JOHN (12345678)"` parentheses convention; need to
  spot-check real data to confirm. Capture 20+ real associate strings
  and document the formats seen.

---

## Source B — Compliance (Enviance)

**B-Q1 ✅ RESOLVED 2026-06-02.** Data endpoint identified — EQL query-
builder at `go.enviance.com/CustomApp/.../query-template.eqlx?name=<panel>__WfAdapt.getWfs`.
Real task data captured. See `dev/ENVIANCE_FINDINGS.md`.

- The query body contains an `IMPERSONATE '<user-guid>'` clause that
  varies per user, so the SW cannot construct the query string itself.
  Solution: capture-and-replay (mirror of digitallocks Power BI pattern).
- Implementation deferred to Phase 2.

**B-Q2 ✅ RESOLVED.** Panel UUID is the query-name prefix, not a
facility encoding. The facility filter is implied by the user's group
membership in the `IMPERSONATE` clause — the query naturally returns
this user's facility's tasks.

**B-Q3 ✅ RESOLVED.** Workflow type name is available via
`<panel>__WfInstFieldsLoad.getCfsOneToOne` (`Workflow_WFI_Type_Name`,
e.g. "EWI-EyeWashInspection-v2"). Better than the prefix heuristic in
DATA_CONTRACTS.

**B-Q4.** ⚠️  Rate limit unprobed. Recommend keeping 6h interval V1.

**B-Q5.** Out of scope V1.

---

## Source C — Accident Evidence (one.walmart.com)

**C-Q1 (BLOCKER).** Is the data delivered as HTML (server-rendered after
POST) or as JSON XHR?

- Probe: load the page, enter store 1458, click Go, watch network.
- Save to `dev/probe-accident-evidence.mjs` + `dev/ACCIDENT_EVIDENCE_FINDINGS.md`.

**C-Q2.** Does the page support GET with a `storeNbr=` query param, or
only POST after form submit?

- GET would let the SW fetch directly without simulating form submission.
- POST forces either a content-script driver or a form-encoded body
  matching the page's expected fields.

**C-Q3.** What's the canonical value space for the evidence status
columns?

- Inferred: "Complete", "Missing", "Partial", blank. Confirm by examining
  ~20 rows of real data.
- Look for surprise values: "N/A", "Pending Review", "Submitted", etc.

**C-Q4.** Is "Days since claim Open" computed by the page or stored as a
raw open-date field?

- If raw open-date is exposed, we should capture it and re-derive
  `daysOpen` ourselves — handles timezone edges cleanly.

**C-Q5.** Does the page support pagination or all-rows-in-one-response?

- For stores with many open claims, response size matters for polling
  cadence.

---

## Source D — CVP (Hoops)

**D-Q1.** ✅ **RESOLVED 2026-06-02.** Cross-origin cookie behavior is N/A
for the actual per-store endpoint — it's same-origin tRPC, not the
cross-subdomain GraphQL the original discovery assumed. Direct
`fetch(..., { credentials: "include" })` from `chrome-extension://`
verified working against `hoops.wal-mart.com`. See
`dev/HOOPS_PERSTORE_FINDINGS.md`.

**D-Q2.** ✅ **RESOLVED.** `timeType=202` = trailing weeks (per
`timeOffset: -13..0` in the response).

**D-Q3.** ✅ **RESOLVED.** No fiscal-week helper needed — response
includes `timeOffset === 0` for current week.

**D-Q4.** Partially resolved. The page fires 4 CVPOverview calls with
different dept/sbu filters. Headline = `[-9999]/[-9999]` (used by
Phase 1). Dept-group drill-downs are V2.

---

## Source E — Register Long/Short (Power BI)

**E-Q1 (BLOCKER for V1.5; not for V1).** What property names identify
the register grid's primary query?

- Probe: open the report in remote-debug Edge with
  `digitallocks/content/capture.js` already loaded (or extended with a
  no-op matcher), wait for the grid to render, dump
  `window.__APAISUITE_DIGITALLOCKS_CAP.all()` to file. Inspect for the
  query whose body selects the register × date cells.
- Likely candidates: `"Register"`, `"Register Number"`, `"Register #"`,
  `"REG_NBR"`.

**E-Q2.** Operator-detail drill-through: what triggers it (click vs.
hover vs. visual-level menu), and what does the request body look like?

- Probe: capture clicks/highlights on the cells. Record the drill-through
  query.
- May reveal that operator detail is only available with a specific
  visual-level filter applied; if so, the auto-pull strategy is
  "iterate over high-interest cells from R1 findings, drive a click,
  capture the drill-through response."

**E-Q3.** For the V1 manual XLSX import: what is the exact column header
shape Power BI exports?

- Probe: manually click Export → Excel, open the file, document the
  header rows. We need to know:
  - Is there a "Store" column or is store implied by the report's slicer?
  - Date format in column headers
  - How are totals labeled (e.g. "Grand Total")
  - Are there merged cells or multi-level headers?

**E-Q4.** Are register numbers preserved as integers, strings, or
mixed?

- Power BI sometimes silently coerces "01" → 1. Confirm by exporting and
  looking at the raw cell types in the xlsx.
- Implication for [DATA_CONTRACTS.md §5](DATA_CONTRACTS.md) — we treat
  them as strings to preserve leading zeros if any exist.

**E-Q5.** What is the maximum time window the report covers in one view?

- Affects the matching algorithm's lookback. If the report shows 7 days
  vs. 30 days vs. fiscal period, the offset-match window
  (default 3 days) interacts with what data is available.

---

## Cross-cutting technical questions

**X-Q1.** `chrome.alarms` doesn't fire while Chrome is fully closed. How
should the dashboard handle "first launch after closed-overnight"?

- Recommended: on view mount, kick off `refresh_all` if any source's
  freshness is stale. This catches the cold-start case for free.

**X-Q2.** Should the dashboard's per-source pulls survive
service-worker death mid-flight?

- Modern SWs idle out after ~30s. A long-running IVR pull (60s with
  retries) could be killed mid-flight.
- Mitigation: each pull writes interim progress to
  `chrome.storage.local` so the next SW wake can pick up. Closinglist's
  IVR scraper already does this via `closinglist.ivrFlowState`.

**X-Q3.** What's the right migration story when adding a new source in
V2?

- Storage keys are versioned (`livedashboard.v1.absences.cache`)? Or
  unversioned and additive-only?
- Recommended: unversioned + additive. Renaming requires a one-shot
  migration handler in `module.js::register(host)`.

**X-Q4.** Should the dashboard emit telemetry to QRCallBox for
"how many users have stale source X right now"?

- Useful for catching origin outages early. Privacy-sensitive — any
  emitted metric must be anonymous (no store nbr, no user ID).
- Defer to V2.
