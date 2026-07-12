# Hoops CVP — per-store endpoint (2026-06-02, follow-on to HOOPS_FINDINGS.md)

Probe script: `dev/probe-hoops-cvp-perstore.mjs`. Full capture: `dev/hoops-perstore-probe.json`.

**Key correction to the original HOOPS_FINDINGS.md.** The per-store CVP page
(`hoops.wal-mart.com/ops-portal/metrics/cvp?bu=1458&buType=6&timeType=202`)
does **NOT** use the GraphQL endpoint `api.hoops.wal-mart.com/report-hub/v1/graphql`
described in the original findings. It uses **tRPC** on the same `hoops.wal-mart.com`
origin. Both endpoints serve CVP data but for different views.

For the Live Dashboard's per-store widget, tRPC is the right choice — same
origin (cookies carry), one call returns 13 weeks of trend, no GraphQL
mutation needed.

## The endpoint

```
GET https://hoops.wal-mart.com/ops-portal/v1/trpc/metric.cvp.megaCard.CVPOverview
    ?input=<URL-encoded JSON>
```

URL-decoded `input`:
```json
{
  "json": {
    "buId":     1458,
    "buType":   6,
    "timeType": 202,
    "depts":    [-9999],
    "sbuIds":   [-9999]
  }
}
```

Where:
- **`buId`** = store number (`1458` here).
- **`buType: 6`** = store-level (per HOOPS_FINDINGS.md).
- **`timeType: 202`** = trailing weeks view (decoded from response: `timeOffset` -13..0).
- **`depts: [-9999]`** = "all departments" sentinel.
- **`sbuIds: [-9999]`** = "all SBUs" sentinel.

The page also fires three additional filtered calls during load:
- `depts:[], sbuIds:[1,4]`
- `depts:[], sbuIds:[3]`
- `depts:[80,81,93,94,97,98], sbuIds:[]`

For the dashboard headline, use the `[-9999]/[-9999]` (all-merch) variant.
Department breakdowns are V2 drill-down candidates.

## Response shape

```json
{
  "result": {
    "data": {
      "json": {
        "type": "SQLBuilderResponse",
        "meta": {
          "isArrayMode": true,
          "columns": [
            "buType","buId","timeType","timeOffset","timeInt",
            "timeTextShort","timeTextLong",
            "cvpSalesQty_Ty454","cvpSalesQty_Ly454",
            "cvpSellThruPct_Ty454","cvpSellThruPct_Ly454",
            "cvpAdherencePct_Ty454","cvpAdherencePct_Ly454",
            "cvpCompliancePct_Ty454","cvpCompliancePct_Ly454",
            "cvpTotalQty_Ty454","cvpTotalQty_Ly454",
            "firstCvpQty_Ty454","firstCvpQty_Ly454",
            "cvpToCvpQty_Ty454","cvpToCvpQty_Ly454",
            "extRetailPriceAmt_Ty454","extRetailPriceAmt_Ly454",
            "extSellPriceAmt_Ty454","extSellPriceAmt_Ly454",
            "extCostAmt_Ty454","extCostAmt_Ly454",
            "returnsAdherencePct_Ty454","returnsAdherencePct_Ly454",
            "returnsExtRetailPriceAmt_Ty454","returnsExtRetailPriceAmt_Ly454",
            "returnsExtSellPriceAmt_Ty454","returnsExtSellPriceAmt_Ly454",
            "returnsExtCostAmt_Ty454","returnsExtCostAmt_Ly454",
            "cvpSalesRetailAmt_Ty454","cvpSalesRetailAmt_Ly454"
          ]
        },
        "rows": [
          [6, 1458, 202, -13, 202605, "WK05", "WM26 WK05",
           2183, 1702, 58.33, 56.84, 60.86, 51.84, 78.16, 70.77, ...],
          [6, 1458, 202, -12, 202606, "WK06", "WM26 WK06",
           1997, 2031, 47.93, 54.53, 67.47, 59.60, 81.92, 70.21, ...],
          ...up to ~13 rows, one per trailing week...
        ]
      }
    }
  }
}
```

**Rows are arrays positionally aligned to `meta.columns`.** Parsing:

```js
function decodeCvpOverview(resp) {
  const cols = resp.result.data.json.meta.columns;
  const idx  = Object.fromEntries(cols.map((c, i) => [c, i]));
  return resp.result.data.json.rows.map((row) => ({
    storeNbr:        String(row[idx.buId]),
    wmWeekText:      row[idx.timeTextShort],          // "WK05"
    wmWeekIntPeriod: row[idx.timeInt],                // 202605 (period)
    timeOffset:      row[idx.timeOffset],             // 0 = current week
    sellThruPctTy:   row[idx.cvpSellThruPct_Ty454],
    sellThruPctLy:   row[idx.cvpSellThruPct_Ly454],
    adherencePctTy:  row[idx.cvpAdherencePct_Ty454],
    compliancePctTy: row[idx.cvpCompliancePct_Ty454],
    cvpTotalQtyTy:   row[idx.cvpTotalQty_Ty454],
    cvpSalesQtyTy:   row[idx.cvpSalesQty_Ty454],
    cvpSalesRetailTy: row[idx.cvpSalesRetailAmt_Ty454],
  }));
}
```

**Current-week selection:** the row with `timeOffset === 0` (or
equivalently, the max `timeInt`).

## Live values (store 1458, captured 2026-06-02)

| Week | TimeInt | SellThru TY | SellThru LY | Adherence TY | Compliance TY |
|---|---|---|---|---|---|
| WK05 | 202605 | 58.33% | 56.84% | 60.86% | 78.16% |
| WK06 | 202606 | 47.93% | 54.53% | 67.47% | 81.92% |
| WK07 | 202607 | 45.61% | 50.04% | 66.10% | (truncated) |
| ... | ... | ... | ... | ... | ... |

Sell-through TY at ~58% means **previous DATA_CONTRACTS thresholds
(green ≥ 25, amber 15–25, red < 15) are wrong for this metric** — the
tRPC `cvpSellThruPct_Ty454` is a different beast than the
`cvpSalesQty / cvpTotalQty` ratio inferred in HOOPS_FINDINGS. The
existing per-market GraphQL gives 10–18% because those numbers are unit
ratios; tRPC reports the business KPI directly.

**Action:** revise CVP thresholds in `RISK_RULES.md` / `risk_rules.json` to
target the actual KPI scale. Reasonable starting bands without store
context:
- green ≥ 55%
- amber 45–55%
- red < 45%

Or — better — keep the existing R10 (sell-through 25%/15% thresholds)
for the GraphQL-derived metric used in ClaimsDisposition, AND introduce
a separate threshold for the tRPC metric used in livedashboard. They are
two different metrics, do not conflate.

## Auth

- Origin: `hoops.wal-mart.com` — same as the page that fires the call.
- Cookies: session cookies on `*.wal-mart.com` and `hoops.wal-mart.com`,
  established by SAML SSO via normal browser session.
- No `Authorization` header needed.
- Direct fetch from extension SW (`credentials: "include"`) should work
  because the host is in `host_permissions` already (`*.wal-mart.com`).
  The extension's `chrome-extension://` origin is treated as cross-origin,
  but Chrome's MV3 cookie behavior attaches cookies for any host the
  extension has permission for. Verify on first run.

## Open questions resolved by this probe

- ✅ **D-Q1 (cross-origin cookie behavior):** N/A for tRPC — same origin
  as user's authenticated session, cookies carry trivially. (Original
  question was about cross-origin from `chrome-extension://` to
  `api.hoops.wal-mart.com`. With tRPC we don't need cross-origin.)
- ✅ **D-Q2 (timeType=202):** trailing weeks (response confirms via
  `timeOffset: -13..0`).
- ✅ **D-Q3 (Walmart fiscal week):** the response includes
  `timeTextShort: "WK05"` and `timeInt: 202605` — we can read the
  current week directly off `timeOffset === 0` rather than computing
  it. No need for a `wmWeek(date)` helper for the per-store endpoint.
- ✅ **D-Q4 (additional queries):** the page fires 4 CVPOverview calls
  with different dept/sbu filters. Headline = `[-9999]/[-9999]`. Others
  are dept-group drill-downs (V2).

## Other calls captured (for future reference)

- `metric.cvp.megaCard.CVPOverview` — the headline metric (above)
- `utils.dept.deptGroup` — list of dept groups (for filter UI)
- `utils.dept.sbuIdDepts` — SBU → dept mapping
- `art.permissions.getArtPermissions` — user's auth permissions
- `common.alignment` — store/market hierarchy data
- `soteria/v1` — Walmart's session/auth check endpoint
- `utils.checkStoreMapExists` — store-map presence boolean

None of these are needed for V1 dashboard.

## Integration note for IMPLEMENTATION_PLAN

The `pull_cvp` SW handler should:
1. Build the tRPC URL with the configured store number.
2. `fetch(url, { credentials: "include" })` — no body, no auth header.
3. Parse the array-mode rows using the `decodeCvpOverview` helper above.
4. Persist all rows to `chrome.storage.local["livedashboard.cvp.cache.<storeNbr>"]`
   (small payload, ~5KB).
5. Identify the current week by `timeOffset === 0`.
6. Drive the widget from the current-week row + render trend chart
   from all rows.
