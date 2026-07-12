# Enviance Compliance — endpoint probe (2026-06-02)

Probe script: `dev/probe-enviance-compliance.mjs`. Full capture: `dev/enviance-probe.json`.

## What we learned

Enviance is a **EQL** (Enviance Query Language — a SQL-flavored query
language) based platform. All data flows through a query-builder endpoint
that takes an EQL string in the request body.

## The endpoint

```
POST https://go.enviance.com/CustomApp/<systemId>/app/core/query-builder/query-template.eqlx?name=<queryName>
Content-Type: application/x-www-form-urlencoded
Cookie: <Enviance SAML SSO — managed by browser>

eqlQueryParam=<URL-encoded JSON>
```

Where:
- `<systemId>` = `ddde6520-3955-4d83-b0ab-78f6e5cbaf10` (the AP Suite Custom App)
- `<queryName>` = identifies which named EQL template the server should
  execute. Many query names are panel-prefixed, e.g.
  `cd2f57ae-5625-4762-8f88-1d47d915cc54__WfAdapt.getWfs` where the prefix
  matches the panel UUID in the URL fragment.
- `eqlQueryParam` body is form-encoded; the value is a JSON object:
  ```json
  {
    "parameters": {
      "eqlQuery": "<the actual EQL SQL>",
      ...
    },
    "page": 1,
    "pageSize": 100
  }
  ```

## The winning query — compliance task list

Query name: `cd2f57ae-5625-4762-8f88-1d47d915cc54__WfAdapt.getWfs`

EQL body (decoded):
```sql
IMPERSONATE '<user-guid>' WITH ['ManageWorkflows','ManageUsers','ManageGroups','ManageRequirementTemplates']
SET CULTURE='en-US'
SELECT DISTINCT
  wfi.ID                 as [id]
, wfi.Name               AS [name]
, wfi.PrimaryStatus      As [primaryStatus]
, parent_wi.ID           AS [parentId]
, ...
, Poi_P_Name             AS [Poi_P_Name]          -- "Facility 01458"
, Workflow_WFI_DueDate                            -- ISO timestamp
FROM ...
```

**`IMPERSONATE` clause carries the current user's Enviance GUID.** This
GUID is per-user — extension code cannot hardcode it. Three viable
approaches:

1. **Bootstrap-extract.** First-time the dashboard pulls compliance, open
   a background `go.enviance.com` tab, capture the user GUID from one of
   the bootstrap calls (e.g. `_SecurityFacade.getUserGroups`), persist to
   `chrome.storage.local["livedashboard.enviance.userGuid"]`. Replay the
   getWfs query from SW thereafter.

2. **Tab-script every pull.** Open background tab, run the query via
   `chrome.scripting.executeScript` in that tab's context — the page's
   own JS modules can fire the call with the right impersonation. Cleaner
   but slower; tab must remain open.

3. **Capture-and-replay.** Mirror the digitallocks Power BI pattern: a
   MAIN-world content script captures the exact getWfs request the page
   fires, ring-buffers it, and the SW replays the captured body verbatim
   on demand. Most robust against query-template changes.

**Recommended: option 3** for V1. Same pattern the suite already uses for
digitallocks/Power BI. Add a small MAIN-world content script at
`modules/livedashboard/content/enviance_capture.js` declared on
`go.enviance.com`.

## Response shape (getWfs)

```json
[
  {
    "columns": [
      {"name":"id","size":-1,"dataType":"Guid"},
      {"name":"name","size":255,"dataType":"String"},
      {"name":"primaryStatus","size":-1,"dataType":"Boolean"},
      {"name":"parentId","size":-1,"dataType":"Guid"},
      {"name":"grandparentId","size":-1,"dataType":"Guid"},
      {"name":"Poi_P_Name","size":255,"dataType":"String"},
      {"name":"Workflow_WFI_DueDate","size":-1,"dataType":"DateTime"}
    ],
    "rows": [
      {"values":[
        "35f76f3e-c2a9-49ee-bf83-209342519816",
        "Weekly Eyewash Inspection",
        true,
        null,
        null,
        "Facility 01458",
        "2026-06-05T03:45:00"
      ]},
      {"values":[
        "8716e5f5-9b8e-4951-aa33-1fcac0575da1",
        "Weekly Hazwaste Inspection",
        true, null, null,
        "Facility 01458",
        "2026-06-05T04:45:00"
      ]},
      {"values":[
        "4346120b-8622-4a24-a860-f032b30e230f",
        "Monthly SPCC Inspection",
        true, null, null,
        "Facility 01458",
        "2026-06-11T03:45:00"
      ]},
      ...
    ]
  }
]
```

Two follow-on queries enrich the rows:
- `<panel>__WfInstFieldsLoad.getCfsOneToOne` — adds `Workflow_WFI_Type_Name`
  (e.g. "EWI-EyeWashInspection-v2"), `Workflow_WFI_UniqueID`,
  `Workflow_WFI_Step_Name` (e.g. "Assessment").
- `<panel>__WfInstFieldsLoad.getAssignedTo` — adds
  `Workflow_WFI_Assignee_GroupName` (e.g.
  "FLG - FL-APManager-Facility 1458") or assignee user details.

For V1 dashboard, the headline query alone (`getWfs`) is enough.

## Sample real data captured (facility 01458, current as of 2026-06-02)

| Task | Due (UTC) | Assigned |
|---|---|---|
| Weekly Eyewash Inspection | 2026-06-05T03:45 | FLG - FL-APManager-Facility 1458 |
| Weekly Hazwaste Inspection | 2026-06-05T04:45 | FLG - FL-APManager-Facility 1458 |
| Monthly SPCC Inspection | 2026-06-11T03:45 | FLG - FL-APManager-Facility 1458 |
| Safety Assessment | 2026-06-30T22:45 | (assignee group) |
| (more...) | | |

Mapping to `ComplianceTask` schema:
```js
{
  facility:       "01458",                 // strip "Facility " prefix
  taskName:       "Weekly Eyewash Inspection",
  assignedGroups: ["FL-APManager-Facility 1458"], // strip "FLG - " prefix
  dueDate:        "2026-06-05",            // YYYY-MM-DD from ISO ts
  dueAt:          "2026-06-05T03:45:00Z",
  daysUntilDue:   3,
  isOverdue:      false,
  isDueSoon:      true,
  category:       "weekly",                // string-prefix heuristic
  ...
}
```

The leading-zero facility string is preserved (`"01458"`), confirming our
schema decision to keep facility/store/operator IDs as strings.

## Auth

- Domain: `go.enviance.com` — has its own SAML SSO redirect (not Walmart
  SSO directly; Enviance is a 3rd-party tenant that delegates).
- Cookies: session cookies on `.enviance.com`, established when user
  signs in once via browser.
- No additional auth header required for the data calls — pure cookie
  session.
- **No host permission for go.enviance.com is currently in manifest.json.
  MUST be added before any pull works.**

## Resolved open questions

- ✅ **B-Q1 (data endpoint):** identified — `query-template.eqlx`.
- ✅ **B-Q2 (panel UUID encodes facility?):** No — panel UUID is the
  query-name prefix only. Facility appears inside the EQL `WHERE` clause
  (the actual store-filter mechanism). For dashboard purposes the panel
  is already filtered to facility 01458 by the user's group membership
  (the IMPERSONATE clause), so the captured query returns 01458 tasks
  for THIS user regardless.
- ✅ **B-Q3 (category field?):** No explicit category column —
  `Workflow_WFI_Type_Name` (e.g. "EWI-EyeWashInspection-v2") encodes type
  + version. Better than the string-prefix heuristic in DATA_CONTRACTS;
  use the type name when available.
- ⚠️  **B-Q4 (rate limit):** unprobed. Recommend keeping 6h interval V1.
- ⚠️  **B-Q5 (multi-group filtering):** out of scope V1.

## New open questions revealed

- **B-Q6 NEW.** The user-GUID extraction (option 1 above) needs a probe
  to identify which bootstrap call carries the user's GUID in a stable
  position. Candidates from this capture:
  - `_SecurityFacade.getUserName_SecDataAdapt.getUserName` (returns
    user's first/last name only — GUID would be in the IMPERSONATE
    clause already constructed by client JS)
  - `_SecurityFacade.getUserGroups_SecDataAdapt.getUserGroups` (returns
    group list)
  - `api.enviance.com/.../PortalService.svc/portal/dashboard` (returns
    portal structure)
  None of these RETURN the user GUID directly — the client JS must
  store it after login. Likely sources: a cookie, sessionStorage, or
  a global JS variable. Probe v2 needed.

- **B-Q7 NEW.** Compliance task data could also come from the upstream
  `api.enviance.com` REST API (the `PortalService.svc/portal/dashboard`
  endpoint at api.enviance.com returns the entire dashboard config
  including page IDs). Worth a quick check: can we hit
  `api.enviance.com` directly with the user's session and skip the EQL
  layer? Cleaner but only if cookies are scoped to cover both subdomains.

## Integration plan (V1)

**Recommended path for Phase 2 implementation:**

1. Add `host_permissions: "https://go.enviance.com/*"` to `manifest.json`.
2. Add MAIN-world content script
   `modules/livedashboard/content/enviance_capture.js` declared on
   `go.enviance.com/*` (mirror of `digitallocks/content/capture.js` —
   monkey-patch fetch + XHR, ring-buffer the `getWfs` request envelope).
3. `pull_compliance` SW handler:
   - Find or open background `go.enviance.com` tab (the panel URL).
   - Wait for tab `complete` + a few seconds for SPA to fire bootstrap
     queries.
   - Read the captured `getWfs` request envelope via
     `chrome.scripting.executeScript({ world: "MAIN" })`.
   - Replay the request from the SW with `credentials: "include"`.
   - Parse columns+rows into `ComplianceTask[]`.
4. Persist to `chrome.storage.local["livedashboard.compliance.cache"]`.

V1 trade-off: the SPA must boot at least once per session before
`pull_compliance` works. If the tab is closed and the SW reboots, the
captured envelope is lost; we need to re-open the tab once. Acceptable
for V1 (rare event); harden later.
