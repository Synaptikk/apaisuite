# Live Dashboard — Discovery Summary

**Last reviewed:** 2026-06-02 · **Suite version baseline:** 0.8.2

This document is the top-of-stack synthesis of the backend/data discovery for
the future APAISuite **Live Dashboard** module (header/home widget surface
that shows high-priority daily operational signals: who called off, what's
overdue, what evidence is missing, CVP/sell-through status, and register
exceptions worth investigating).

> **Scope of this session.** Backend/data discovery only. No UI build, no new
> module code. Outputs in this folder are the contract that a future
> implementation session will execute against.
>
> **Confidence calibration.** Most endpoint details below are *inferred from*
> URL patterns the user supplied, plus directly verified analogous patterns
> already running in the suite. Items that have been verified by live probe
> (Hoops CVP) say so explicitly. Items that have NOT been verified say so
> explicitly. Do not assume confidence equals correctness — a probe session
> is still required for sources B, C, and the Power BI register report.

---

## TL;DR feasibility

| Source | What | Feasibility | Reuses |
|---|---|---|---|
| **A** | Associate absences / tardies (IVR ATT Cloud) | **High — already shipped, just subscribe** | `closinglist` module's `content/ivr.js` already runs the multi-page flow and posts `ivr-absences-collected` |
| **B** | Compliance task due dates (Enviance) | **Medium — net-new origin, probe needed** | Pattern from any SSO'd suite module (`captureHeader` / `readCookiesViaTab`) |
| **C** | Accident evidence status (one.walmart.com) | **Medium — origin already permitted, specific endpoint unknown** | Same SSO/credentials pattern as Hoops |
| **D** | CVP metrics (Hoops) | **High — endpoint already mapped** | `dev/HOOPS_FINDINGS.md` — `POST api.hoops.wal-mart.com/report-hub/v1/graphql`, per-store variant of the query |
| **E** | Register long/short (Power BI) | **Medium-High — pattern proven, query signature TBD** | `digitallocks/content/capture.js` (MAIN-world fetch+XHR patch on `pbidedicated.windows.net/QES/...`) |

**Net-new permissions required:** `https://go.enviance.com/*` (Source B). All
other origins already in top-level `manifest.json::host_permissions`.

**Net-new content scripts required:**
- One on `https://app.powerbi.com/*` *report-specific filter* for the
  register long/short report's query signature (the `digitallocks` capture
  script is per-report by signature, not per-page; we extend the same module
  pattern with a second matcher rather than a second content script).
- Optionally one on `https://go.enviance.com/*` if the SPA does not expose a
  capturable backend API.

---

## What each source contributes to the dashboard

Each widget surfaces an exception count + drill-down. The dashboard is
deliberately exception-first; "all green" should be visible but compact.

| Widget | Source | Primary signal | Drill-down |
|---|---|---|---|
| Callouts Today | A | Count of associates with absence/tardy today | Table: name, dept, time, type |
| Compliance Due Soon | B | Overdue count + due-within-7-days count | Table: task, due date, assigned group |
| Accident Evidence Gaps | C | Open claims with missing video/photos/statements | Table: ref#, claimant, missing items, days open |
| CVP Snapshot | D | Sell-through % vs threshold; CVP total qty | Trend chart, week-over-week |
| Register Exceptions | E | Unmatched shortages, operator-linked patterns | Per-register grid + operator detail |

Every widget shows state: **green / yellow / red / stale / error**, plus
**last refreshed** time. A single **Refresh Now** button forces a parallel
pull of all sources; a **Store Settings** button changes the default store.

---

## Cross-source dependencies & gotchas (callouts)

1. **Single SSO surface, many origins.** Every backend listed authenticates
   via the company SAML SSO + session cookies on `*.wal-mart.com` /
   `*.walmart.com` / `go.enviance.com`. The suite never stores credentials;
   the user signs in once per origin in normal browser tabs, and the
   extension piggybacks on those sessions. See [SECURITY_NOTES.md](SECURITY_NOTES.md).

2. **Hoops cross-origin cookie behavior is the gating unknown for source D.**
   Per `dev/HOOPS_FINDINGS.md`, a direct `fetch(..., { credentials: "include" })`
   from `chrome-extension://...` to `api.hoops.wal-mart.com` *should* carry
   the SSO cookies (they're scoped to `.wal-mart.com`), but this has not
   been verified end-to-end. If SameSite=Lax blocks it, the fallback is
   `chrome.scripting.executeScript` into a `hoops.wal-mart.com` tab — same
   pattern as the `workvivo` module.

3. **Power BI query payloads are big and tenant-scoped.** Don't hardcode
   them. The `digitallocks` pattern is the correct one: capture in
   MAIN-world, mutate the slicer filter (store / report-scope), replay from
   SW. For the register long/short report, the *report id* in the URL
   (`65c97d6a-7ad8-498d-b752-69028d408993`) and the *workspace id* (the
   `groups/me` segment) are stable per-report; the dataset id is captured at
   runtime.

4. **Enviance (Source B) hash routing is a tell.** The URL fragment
   `#/panel/<uuid>/false` is a client-side route — the page is a SPA that
   queries one or more APIs after the initial HTML load. The actual data
   call is unknown without a network capture; the panel UUID is likely the
   request key. See [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) for the specific
   probe to run.

5. **IVR Cloud's web-farm rejects ~50% of POSTs.** The existing
   `closinglist` IVR scraper retries up to 5 times for "Validation of
   viewstate MAC failed". The dashboard inherits this; budget polling
   accordingly (see [POLLING_PLAN.md](POLLING_PLAN.md)). Don't poll absences
   tighter than 15 min — the retry storm gets visible in logs.

6. **Register long/short is the hardest analysis problem, not the hardest
   data problem.** Pulling the Power BI grid is mechanically similar to
   DigitalLocks. The *analysis* (matching shortages to nearby overages,
   isolating bounce-backs from suspicious losses, linking operators) is
   where the value is. [RISK_RULES.md](RISK_RULES.md) details the matching
   algorithm; the V1 should ship rules R1–R3 (offset matching) and add R4–R5
   (operator exposure) once operator detail is reliably captured.

---

## What's been done since first draft (2026-06-02 Phase 1 build)

- **Phase 1 module shipped** at `modules/livedashboard/` (v0.1.0). Two
  live sources (CVP, Absences), three placeholder widgets, full grid UI,
  Refresh Now + Store selector, freshness tracking, 15-min alarms.
- **Source D — CVP — fully live.** Probe `dev/probe-hoops-cvp-perstore.mjs`
  surfaced a **different endpoint than originally documented**: tRPC
  `hoops.wal-mart.com/ops-portal/v1/trpc/metric.cvp.megaCard.CVPOverview`,
  not the GraphQL API. See `dev/HOOPS_PERSTORE_FINDINGS.md`. Returns 13
  weeks of trend in one call. Direct `cvpSellThruPct_Ty454` (not a
  divided ratio). Verified end-to-end: store 1458 shows ~56.7% sell-
  through, widget renders green. CVP thresholds revised to 55/45 bands.
- **Source B — Compliance — endpoint mapped.** Probe
  `dev/probe-enviance-compliance.mjs` identified the EQL query-builder
  at `go.enviance.com/CustomApp/.../query-template.eqlx?name=<panel>__WfAdapt.getWfs`.
  Real task data captured (Weekly Eyewash Inspection, Monthly SPCC, etc.).
  Per-user `IMPERSONATE` clause means we need capture-and-replay (mirror
  of digitallocks Power BI pattern). Implementation deferred to Phase 2.
  See `dev/ENVIANCE_FINDINGS.md`.
- **Source A — Absences — bridge ready.** `modules/livedashboard/lib/sources/absences.js`
  cross-calls `closinglist`'s existing `collect-ivr-absences` handler;
  normalization + rollup helpers in place. Live IVR collect not invoked
  during automated test (heavy side effect: opens IVR tab, runs 3-page
  WebForms scrape, ~5–60s). Click "Refresh Now" on the dashboard to
  trigger.

## What is STILL not done

- **Source C — Accident Evidence — probe inconclusive.** First probe
  found a generic page with no store-input form on initial load — the
  form is likely in an iframe or a deeper widget. Probe v2 needed with
  iframe detection + longer wait. See `dev/ACCIDENT_EVIDENCE_FINDINGS.md`.
- **Source E — Power BI register report — no probe yet.** Mechanism is
  proven (digitallocks). Needs a tab open on the register report so the
  MAIN-world capture script can identify the query signature.
- **Compliance source — implementation pending.** Endpoint is mapped;
  capture-and-replay needs a content script on `go.enviance.com/*` +
  host_permissions addition.
- **No risk-rule engine in Phase 1.** The data contracts are in place;
  the matching algorithm in `RISK_RULES.md` is not yet wired.

---

## Reading order

If you have 5 minutes: this file + [SOURCE_MAP.md](SOURCE_MAP.md).

If you're picking up implementation: this file + [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) +
the source-specific section of [ENDPOINTS.md](ENDPOINTS.md).

If you're designing the analysis logic: [DATA_CONTRACTS.md](DATA_CONTRACTS.md) +
[RISK_RULES.md](RISK_RULES.md).

If you're scheduling polling: [POLLING_PLAN.md](POLLING_PLAN.md).

If you have security/compliance questions: [SECURITY_NOTES.md](SECURITY_NOTES.md).
