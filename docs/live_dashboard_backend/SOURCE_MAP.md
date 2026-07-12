# Source Map

One-line-per-source reference. Detail lives in the other docs in this folder.
Use this to answer "what are we pulling, from where, by what method, how
confident are we?" without reading everything.

**Last reviewed:** 2026-06-02.

---

## Legend

- **Status.** `shipped (subscribe)` = data is already produced by an existing
  module, we just consume it. `pattern proven` = exact analog exists in suite,
  apply it. `probe required` = mechanism understood, but specific
  endpoint/payload not yet verified. `unknown` = not yet investigated.
- **Confidence.** Subjective likelihood the implementation will work as
  specified without surprises. **H/M/L** for High / Medium / Low.
- **Data Method.** `bg-fetch` = SW direct fetch with `credentials: "include"`
  on cookie-bearing domain. `tab-script` = `chrome.scripting.executeScript`
  into a logged-in tab. `cs-capture` = MAIN-world content script captures
  the page's own XHR/fetch. `manual-import` = user-driven file
  upload/paste/export as fallback.

---

## The table

| Source | URL | Manual Workflow | Data Method | Status | Confidence | Notes |
|---|---|---|---|---|---|---|
| **A — Absences/Tardies** | `https://ivrattcloud-prod.wal-mart.com/` | Menu → AIL Absences and Tardies → Next → Current Day → Display Report | `cs-capture` (existing) | shipped (subscribe) | **H** | `modules/closinglist/content/ivr.js` already drives the flow and scrapes `#ailTable_1`. Dashboard subscribes to the existing `ivr-absences-collected` broadcast or invokes the existing handler. No new scraping. Web-farm rejects ~50% of POSTs — built-in retry up to 5×. |
| **B — Compliance Tasks** | `https://go.enviance.com/CustomApp/.../index.html#/panel/<uuid>/false` | Open page, panel auto-loads facility 01458 tasks | unknown — likely `bg-fetch` of SPA API once endpoint captured | probe required | **M** | Net-new origin. Need `host_permissions` entry. SPA — data is fetched after initial HTML. Panel UUID in URL fragment is likely the request key. Probe via DevTools network tab while page loads; look for JSON XHR. |
| **C — Accident Evidence** | `https://one.walmart.com/content/.../accident-charge-summary.html` | Enter store nbr, click Go, review two tables | unknown — likely AEM-served page with embedded data OR XHR after form post | probe required | **M** | Origin permitted via `*.walmart.com`. Page is hosted on AEM (`one.walmart.com/content/...`). Data may be embedded in initial HTML or fetched via XHR after form submit. Need to inspect form action + response. Two distinct report types per page (Bodily Injury + Garage Keeper). |
| **D — CVP Metrics** | `https://hoops.wal-mart.com/ops-portal/metrics/cvp?bu=1458&buType=6&timeType=202` | URL renders the CVP dashboard for store 1458 | `bg-fetch` to `api.hoops.wal-mart.com/report-hub/v1/graphql` | pattern proven | **H** | `dev/HOOPS_FINDINGS.md` proves the endpoint + query for market roll-up. Per-store variant: swap `marketNbr: {eq: N}` → `storeNbr: {eq: 1458}` (plus keep `buType: 6` and `wmWeekNbr`). Cross-origin cookie behavior is the unverified bit. |
| **E — Register Long/Short** | `https://app.powerbi.com/groups/me/reports/65c97d6a-7ad8-498d-b752-69028d408993/ReportSection?...` | Open report, observe register × date grid, click cells for operator detail | `cs-capture` (mirror of digitallocks) + `manual-import` fallback | pattern proven | **M-H** | `modules/digitallocks/content/capture.js` is the template. Need a second query-signature matcher in the same (or sibling) content script that detects "Register" + date-column distinctive properties. Operator detail likely behind a drill-through query — capture separately. V1 fallback: user clicks Export → Excel; we capture the xlsx download. |

---

## Origin → permissions audit

What the suite's current `manifest.json::host_permissions` covers for each
source. **Anything marked "ADD"** is a required `manifest.json` edit before
the live-dashboard module can ship.

| Origin | Required by | Currently in manifest? |
|---|---|---|
| `https://ivrattcloud-prod.wal-mart.com/*` | A | yes — already used by `closinglist` |
| `https://go.enviance.com/*` | B | **ADD** |
| `https://*.walmart.com/*` (covers `one.walmart.com`) | C | yes |
| `https://*.wal-mart.com/*` (covers `hoops.wal-mart.com`, `api.hoops.wal-mart.com`) | D | yes |
| `https://app.powerbi.com/*` and `https://*.pbidedicated.windows.net/*` | E | yes — already used by `digitallocks` |

---

## Content-script declarations needed

Current `manifest.json::content_scripts` declares scripts for: CaseVisibility,
IVR, gscope order resolution, Clearsight wrapper, Power BI. For the live
dashboard:

| Match pattern | Script | Existing or new? |
|---|---|---|
| `https://ivrattcloud-prod.wal-mart.com/*` | `closinglist/content/ivr.js` | existing — reuse |
| `https://app.powerbi.com/*` | `digitallocks/content/capture.js` | existing — **extend matcher inside the file** (don't add a second declaration; one script can match multiple query signatures via a small registry) |
| `https://go.enviance.com/*` | TBD — only if SPA does not expose a capturable backend API | probe-dependent |
| `https://one.walmart.com/content/.../accident-charge-summary.html` | TBD — only if the page form-posts to itself and we need to scrape the rendered tables | probe-dependent |

The "probe-dependent" entries should NOT be added preemptively. Add them
only after a probe confirms a content-script approach is needed (vs. a
direct background fetch).
