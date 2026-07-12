# Hoops CVP Performance — endpoint probe (2026-06-02)

Probe script: `dev/probe-hoops-cvp.mjs`. Full capture: `dev/hoops-probe.json`.

## The endpoint

```
POST https://api.hoops.wal-mart.com/report-hub/v1/graphql
```

GraphQL. Auth via session cookies on `*.wal-mart.com` (user signs into Hoops via SSO once; subsequent cross-subdomain fetches with `credentials: "include"` should carry them — needs to be verified from extension origin).

## The query that gives us per-store Sell Through

This is the per-store breakdown for Market 120 for a given Walmart week:

```graphql
query {
  result: cvpBuTypeBuIdWeekDeptGroupGet(where: {
    and: [
      {marketNbr:    {eq: 120}},
      {wmWeekNbr:    {eq: 26}},      # current Walmart fiscal week
      {buType:       {eq: 6}},        # buType 6 = store-level (5 = market roll-up)
      {deptGroupNbr: {eq: 2}}         # 2 appears to be "all merch"; 0 = uncategorized
    ]
  }) {
    marketNbr storeNbr wmWeekNbr deptGroupNbr
    firstCvpQty_Ty454            # units CVP'd for the first time this year
    cvpToCvpQty_Ty454            # units re-CVP'd (second markdown)
    cvpTotalQty_Ty454            # total CVP units active
    cvpSalesQty_Ty454            # units that SOLD while in CVP — Sell Through numerator
    cvpSalesRetailAmt_Ty454      # $ recovered through CVP sales
  }
}
```

## Real response (Market 120, week 26)

```json
{
  "data": {
    "result": [
      { "storeNbr": 658, "firstCvpQty_Ty454": 2736, "cvpToCvpQty_Ty454": 1998,
        "cvpTotalQty_Ty454": 6470, "cvpSalesQty_Ty454": 1155,
        "cvpSalesRetailAmt_Ty454": "5253", "wmWeekNbr": 26 },
      { "storeNbr": 669, "firstCvpQty_Ty454": 2786, "cvpToCvpQty_Ty454": 2356,
        "cvpTotalQty_Ty454": 9786, "cvpSalesQty_Ty454": 1051,
        "cvpSalesRetailAmt_Ty454": "5552", "wmWeekNbr": 26 },
      { "storeNbr": 756, "firstCvpQty_Ty454": 2114, ... },
      ...
    ]
  }
}
```

## Sell-Through formula

```
sellThrough = cvpSalesQty_Ty454 / cvpTotalQty_Ty454
```

Higher = healthier (more CVP'd merch sold instead of disposed). Examples:
- Store 658: 1155 / 6470 = **17.8%**
- Store 669: 1051 / 9786 = **10.7%**  (lower — more CVP merch sitting / being disposed)

A store with HIGH disposal rate AND LOW sell-through is the exact pattern Shane wants to surface — "CVP it then immediately dispose it instead of selling it."

## Field glossary (best inference)

| Field | Meaning |
|---|---|
| `_Ty454` suffix | This Year, fiscal-week-based metric |
| `_Ly454` suffix | Last Year, same window |
| `firstCvpQty` | Units that hit CVP for the first time |
| `cvpToCvpQty` | Units re-CVP'd after a prior markdown didn't move them |
| `cvpTotalQty` | All CVP units currently in play |
| `cvpSalesQty` | Units that actually sold while marked down |
| `cvpSalesRetailAmt` | $ recovered through CVP sales |
| `fromReturnsFirstCvpQty` | CVP'd units that originated as returns |
| `buType: 5` | Market roll-up row |
| `buType: 6` | Store-level row |
| `deptGroupNbr: 2` | "All merch" grouping (seems to be the default for the headline KPI) |

## Open questions

1. **Cross-origin cookie behavior from extension SW.** Hoops uses session cookies at `*.wal-mart.com` domain scope. Need to verify a direct `fetch` from `chrome-extension://...` to `api.hoops.wal-mart.com/...` with `credentials: "include"` actually carries the cookies. If not (SameSite=Lax cookies blocking cross-origin), we'd route via `chrome.scripting.executeScript` into a `hoops.wal-mart.com` tab — same pattern as Workvivo.
2. **Walmart fiscal week computation.** `wmWeekNbr` is the Walmart fiscal week (not ISO week). Need a small helper to compute the current Walmart week from `new Date()`. The dashboard currently passes `26` for the period right before today (2026-06-02 → Walmart FY27 week 17ish? Need to confirm the fiscal-year offset).
3. **Department group choice.** The dashboard cycles through `deptGroupNbr: 0` and `2`. Default to `2` ("all merch") for the headline, drill-down by group can come later.

## Integration plan (proposal for next step)

**Minimum viable:**
- New SW handler `claimsdisposition.pullCvpPerformance` (called separately from the existing Looker pull, or chained after it). Pulls one week's data for all 10 stores in one GraphQL call.
- Store result in chrome.storage.local under `claimsdisposition.cvpByStore.<week>` (small payload — 10 rows × 7 fields = ~2 KB).
- Add **"Sell Through"** column to Store Comparison table. Color-coded: green ≥ 25%, amber 15–25%, red < 15%.
- Add **R10** outlier rule: `sellThrough < 15% AND cvpTotalQty >= 100` → at least Medium severity. Bumps to High if sellThrough < 10%.

**Stretch:**
- Sell-Through trend chart per store (last 8 weeks) in the detail drawer.
- Combined R11: "low sell-through + high disposal rate" — a compound signal stronger than either alone.
