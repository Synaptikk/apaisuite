# Endpoints

Per-source endpoint detail: URL, method, parameters, auth/session model,
request/response shape (verified or inferred), and which execution context
the call can be made from.

**Sensitive-value policy.** This document **never** records cookie values,
bearer tokens, SSO headers, or any secret. We record header *names*, whether
they're required, and where the browser obtains them — never the value.

**Verification levels.**
- **V — verified.** Captured live in a probe; payload shape is real.
- **I — inferred.** Derived from a verified analog + the URL/page pattern;
  has not been independently confirmed against the actual endpoint.
- **U — unknown.** Awaiting a probe session.

---

## Source A — Absences/Tardies (IVR ATT Cloud)

**Bottom line.** No new endpoint to discover. The
`closinglist/content/ivr.js` script already drives the multi-page WebForms
flow (Menu radio → Next → "Current Day" radio → Display Report) and
scrapes the rendered absence table. The Live Dashboard module subscribes
to the broadcast OR invokes the existing service handler to trigger a
fresh collect.

### Existing message contract (V)

Out (from content script → SW):
```js
chrome.runtime.sendMessage({
  module:     "closinglist",
  type:       "ivr-absences-collected",
  ok:         true | false,
  error:      string | null,
  rows:       [{
    associate:      string,
    absence_date:   string,    // "MM/DD/YYYY"
    dept:           string,
    job:            string,
    call_date_time: string,    // raw display string
    absence_type:   string,
    absence_reason: string,
    confirmation:   string | null,
    source:         string | null,
  }],
  capturedAt: string | null,   // ISO
  sourceUrl:  string,
});
```

In (SW → content script):
- `ivr-ping` — `{ ok, where, pageUrl }`
- `ivr-progress-now` — `{ ok }`
- `ivr-scrape-now` — `{ ok, rows, capturedAt }`

### Triggering a fresh pull from the dashboard

The dashboard's SW handler will need to:
1. Find or open a background `ivrattcloud-prod.wal-mart.com` tab
   (`host.tabs.findOrOpen`).
2. Set `chrome.storage.local["closinglist.ivrFlowState"]` to
   `{ active: true, startedAt: Date.now(), macErrorRetries: 0 }`.
3. Wait for an `ivr-absences-collected` message (matching module +
   capturedAt > our start time). Timeout ~3 min (covers MAC-error retries).

**Note.** This couples `livedashboard` to `closinglist` internals. Two
options for the future contract refactor (out of scope for this discovery):
- **a)** Promote `ivr-absences-collected` to a suite-level broadcast (e.g.
  `module: "_suite"`, `type: "absences-collected"`) and have closinglist
  re-broadcast.
- **b)** Move IVR scraping into a `shared/sources/ivr.js` helper that both
  modules call. This is the cleaner long-term shape but bigger refactor.

For V1, option (c): just message-cross. Document the coupling in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

### Context feasibility

| Context | Works? |
|---|---|
| SW direct fetch | **No** — page uses ASP.NET WebForms `__VIEWSTATE` postback; flow only works in a real loaded DOM |
| Content script (existing) | **Yes** — proven |
| Manual import fallback | not needed |

---

## Source B — Compliance Tasks (Enviance go.enviance.com)

**Verification: U.** Specific endpoint unknown. The URL pattern strongly
suggests this is a SPA panel that fetches its data after the initial HTML
loads.

### What we know (I)

- URL: `https://go.enviance.com/CustomApp/<systemId-uuid>/index.html?SystemID=<system-uuid>#/panel/<panel-uuid>/false`
- The `#/panel/<uuid>/false` segment is client-side hash routing — the page
  reads it and fetches data accordingly.
- The display shows columns: `Facility | Due Date | Task Name | Assigned Groups`,
  so the underlying response is row-shaped and per-task.
- Facility filter is somehow scoped to "01458" (the leading zero is
  preserved — Enviance facility IDs may be left-padded strings; do NOT
  strip leading zeros).

### Probe to run (gets us to V)

1. Open the URL in Edge with `dev/launch-edge-debug.sh` (remote debugging
   port enabled).
2. Open DevTools → Network → preserve log → clear → reload page.
3. After page renders the task list, filter by XHR/Fetch.
4. Look for a JSON response that contains "Weekly Eyewash Inspection" or
   similar string. Record:
   - Endpoint URL
   - Method
   - Request body (likely JSON or form-encoded with panel-uuid + facility
     filter)
   - Required cookie/header names (NOT values)
   - Whether the response is one row per task or one aggregated payload
5. Capture in `dev/probe-enviance.mjs` + `dev/ENVIANCE_FINDINGS.md`
   following the convention of `dev/HOOPS_FINDINGS.md`.

### Inferred shape (replace with real once probed)

```http
POST https://go.enviance.com/Service/<service-name>/Query
Content-Type: application/json
Cookie: <SSO session — managed by browser, do not log>

{
  "panelId":   "cd2f57ae-5625-4762-8f88-1d47d915cc54",
  "facility":  "01458",
  "filters":   { ... }
}
```

Response (inferred):
```json
{
  "rows": [
    {
      "facility":        "01458",
      "dueDate":         "2026-06-09T00:00:00Z",
      "taskName":        "Weekly Eyewash Inspection",
      "assignedGroups":  ["AP", "Facilities"]
    },
    ...
  ]
}
```

### Context feasibility (I)

| Context | Likely? |
|---|---|
| SW direct fetch | **Likely yes** if cookies are scoped to `.enviance.com` and SameSite allows. Same gating question as Hoops. |
| Content script (cs-capture) | **Yes** as fallback — works regardless of cross-origin cookie behavior |
| Manual import | not needed — page is auth-only, no exposed export |

---

## Source C — Accident Evidence (one.walmart.com)

**Verification: U.** The page is on AEM (Adobe Experience Manager) at
`one.walmart.com/content/...`, which means it's either a server-rendered
page with embedded data OR a thin shell that XHRs after a form submit.

### What we know

- URL: `https://one.walmart.com/content/uswire/.../accident-charge-summary.html`
- Manual workflow: enter store nbr → click Go → two tables render:
  1. **Bodily Injury Evidence Report**
  2. **Garage Keeper - Property Damage Evidence Report**
- Both tables have the same column shape: `Reference Nbr | Claimant | Tracking # | Days since claim Open | Customer Statement | Witness Statement | Video | Photos | Evidence Collection Sheet | Evidence Status | Enhanced Export?`
- "Days since claim open" is computed (good — tells us claim open-date is
  somewhere in the source).

### Probe to run

1. Edge with remote debugging.
2. DevTools Network preserve log.
3. Enter store 1458, click Go.
4. Identify whether the response is:
   - **(a)** A full HTML page with both tables embedded (server-side render
     of POST). → Parse tables from injected HTML.
   - **(b)** A JSON XHR returning row data. → Direct background fetch with
     a store-id parameter.
   - **(c)** A mix (HTML shell + XHR per table). → Hybrid.
5. If (a), check whether a `?storeNbr=1458` GET also works (some AEM forms
   accept GET as well as POST — cleaner for the dashboard).
6. Record in `dev/probe-accident-evidence.mjs` + `dev/ACCIDENT_EVIDENCE_FINDINGS.md`.

### Inferred shape (replace with real once probed)

```http
POST https://one.walmart.com/content/.../accident-charge-summary.html/.servlet/data
Content-Type: application/x-www-form-urlencoded
Cookie: <SSO session>

storeNbr=1458
```

Response: HTML with two `<table>` blocks (most likely), OR JSON if the page
has been modernized.

### Context feasibility (I)

| Context | Likely? |
|---|---|
| SW direct fetch | **Yes** — `one.walmart.com` cookies are first-party for any extension request to that origin |
| Content script | **Yes** as fallback |
| Manual import | not needed |

---

## Source D — CVP Metrics (Hoops)

**Verification: V** (endpoint + market-level query) + **I** (per-store query).

### The endpoint (V — see dev/HOOPS_FINDINGS.md)

```http
POST https://api.hoops.wal-mart.com/report-hub/v1/graphql
Content-Type: application/json
Cookie: <SSO session, scoped to .wal-mart.com>
```

### Per-market query (V — proven working)

See `dev/HOOPS_FINDINGS.md` for the full payload. Returns one row per store
in the given market.

### Per-store query (I — inferred from the URL `bu=1458&buType=6`)

The URL the user supplied uses `bu=1458` (store nbr) and `buType=6` (store
level). The corresponding GraphQL filter should be:

```graphql
query {
  result: cvpBuTypeBuIdWeekDeptGroupGet(where: {
    and: [
      { storeNbr:    { eq: 1458 } },
      { wmWeekNbr:   { eq: <current-walmart-week> } },
      { buType:      { eq: 6 } },
      { deptGroupNbr: { eq: 2 } }
    ]
  }) {
    storeNbr wmWeekNbr deptGroupNbr
    firstCvpQty_Ty454
    cvpToCvpQty_Ty454
    cvpTotalQty_Ty454
    cvpSalesQty_Ty454
    cvpSalesRetailAmt_Ty454
  }
}
```

`timeType=202` in the URL is unmapped. Two hypotheses:
- 202 is a current-week-vs-last-year comparison code (Ty/Ly suffix
  pairing).
- 202 is a fiscal-period type (week vs. month vs. quarter).

The probe to confirm: re-run the existing Hoops capture with the user
sitting on `?bu=1458&buType=6&timeType=202` and grep the request body for
`timeType` / `202`.

### Sell-through derivation (V)

```
sellThrough = cvpSalesQty_Ty454 / cvpTotalQty_Ty454
```

### Cross-origin cookie behavior (open)

See `dev/HOOPS_FINDINGS.md` open question #1. Test plan:

```js
// From SW context, after the user has logged into hoops in a normal tab:
const r = await fetch("https://api.hoops.wal-mart.com/report-hub/v1/graphql", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: "..." }),
});
// 200 with data ⇒ direct bg-fetch works
// 401/403 ⇒ fallback to tab-script via chrome.scripting.executeScript
```

### Context feasibility

| Context | Status |
|---|---|
| SW direct fetch (`bg-fetch`) | **Probably yes — needs verification** |
| Tab script fallback | **Definitely yes** (workvivo pattern) |
| Content script | overkill; only if both above fail |

---

## Source E — Register Long/Short (Power BI report)

**Verification: I** for query signature (the digitallocks pattern works on a
different report in the same Power BI workspace, so the *mechanism* is V).

### Report identity

- Workspace: `groups/me` (user's personal workspace — TBD if this is correct
  or if it's a shared workspace the link rewrote)
- Report ID: `65c97d6a-7ad8-498d-b752-69028d408993`
- Tenant ID: `3cbcc3d3-094d-4006-9849-0d11d61f484d`

### Endpoint pattern (V — proven for digitallocks report)

The data grid is rendered by POSTs to:

```
POST https://<tenant-uuid>.pbidedicated.windows.net/<...>/QES/QueryExecutionService/<...>/query
Cookie: Power BI session
Authorization: Bearer <Power BI access token>
```

Body is a Power BI DAX query envelope (large, JSON, tenant- and
report-scoped). The `digitallocks/content/capture.js` script monkey-patches
fetch + XHR in MAIN-world to record these calls into a ring buffer.

### Query signature for the register grid (I)

The digitallocks matcher looks for body containing
`"Property":"Lock Name"` AND `"Property":"store"`. For the register report,
the analog is to look for body containing a `"Property"` value that names
the register column and a date column. Probe to identify the exact property
names (they may be `"Register"`, `"Register #"`, `"Register Number"`, etc.).

```js
findRegisterGridQuery: () => {
  for (let i = ring.length - 1; i >= 0; i--) {
    const r = ring[i];
    const b = r.reqBody || "";
    // exact property names TBD by probe
    if (b.includes('"Property":"Register"') && /"Property":"(Date|TransactionDate|BusinessDate)"/.test(b)) {
      return r;
    }
  }
  return null;
},
```

### Operator detail (drill-through)

Per the user's brief, clicking/highlighting cells reveals operator numbers.
This is a Power BI drill-through query — a second, separate DAX query
fired when a cell is selected. Capture pattern: same MAIN-world hook
records it, with a second matcher (`findRegisterOperatorQuery`) that
identifies the drill-through by its presence of an `"Operator"` property
and a register-specific filter.

V1 may ship without operator detail — the register grid alone identifies
where to look; operator linkage can land in V1.5.

### Manual-import fallback (V1 recommendation)

Per the user's brief and the digitallocks pattern, **V1 should accept a
Power BI Excel export** (drag-drop) and parse it. The grid is small
(registers × dates), so the parser is straightforward:

- Detect date columns: row 1 cells matching a date regex.
- Detect register rows: first column cells parseable as integers in
  expected register-id range (e.g. 1–99).
- Parse cells as signed dollar amounts (negative = short, positive = over,
  blank = no transaction).
- Preserve totals row separately (do not include in per-register
  normalized output).

### Context feasibility

| Context | Status |
|---|---|
| SW direct fetch (`bg-fetch`) | **No** — Power BI uses tenant-scoped tokens not delivered by `credentials: "include"` |
| MAIN-world content script (`cs-capture`) | **Yes** — proven for digitallocks |
| Manual import (`manual-import`) | **Yes** — recommended for V1 |
| `chrome.downloads.onCreated` capture of Export → Excel | **Yes** — digitallocks V1.5 plan, applicable here |
