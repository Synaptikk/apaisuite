# Cost Inventory Calculator — source findings

Probing notes for the planned `costinventory` module. Target artifact:
`Cost-Inventory-Calculator-Worksheet.xlsx` (Fresh monthly cost inventory).

## The worksheet

One sheet. Three divisions side by side; only 25 cells are typed in.

| Division | Dept | Value column |
|---|---|---|
| 24 Meat | 93 Meat/Seafood | C |
| 24 Meat | 80 Deli | D (E = auto total) |
| 25 Produce | 94 Produce | G |
| 27 Bakery | 98 Bakery | J |

Inputs: `C3` store, `E3` date; row 7 Cost Inventory App total (cost),
row 8 Warehouse Truck Invoices (cost), row 9 Claims (cost), row 10 Fuel
Station/Convenience (Deli only), row 13 Sales (Retail), row 14 Beginning
Inventory, row 15 Purchases (Cost).
Everything else is formula: `11 = 7+8+9(+10)`, `16 = 11`, `17 COGS = 14+15-16`,
`18 GP$ = 13-COGS`, `19 GP% = 18/13`.

## 1. Beginning Inventory (row 14) — OneWalmart lookup tool

Page: `https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html`
(NOT the `.../supercenters/Food-Fresh-and-Consumables/Fresh.html` page, which
only links to it).

```
GET  /libs/granite/csrf/token.json            -> { token }
POST /content/api/adp/lookuptools.json
     headers: CSRF-Token: <token>             <- REQUIRED; without it 403
     body:    toolId=<32 hex>&primaryId=<store>
     -> { metadata: { ToolId, lastUpdated }, data: [ { primarykey, column1: dept,
          column2: "$14,929.09", column3: format } ] }
```

Store 1458 verified: 80 $14,929.09 · 93 $71,320.61 · 94 $38,781.29 · 98 $27,599.94.

**toolId is per-month** (the heading reads "Beginning Inventory Store Lookup
Tool - Sept"; `metadata.lastUpdated` 2025-09-02). Do NOT hard-code it — fetch
the page HTML and pick the `<table id="<32 hex>">` whose `<th>`s are
`Store Number, Dept, Inventory Dollars, Format`. Regex is enough (no DOMParser
in an MV3 SW).

## 2. Sales + Purchases (rows 13, 15) — Ops Portal ITR (tRPC)

Page: `https://hoops.wal-mart.com/ops-portal/analysis/inventory/fresh-inventory-tracker?bu=<store>&buType=6&timeType=100`

```
GET /ops-portal/v1/trpc/analysis.fresh.freshInventoryTracker
    ?input={"json":{"buId":1458,"buType":6,"timeType":100,"deptNumber":[93]}}
    -> result.data.json = { meta: { columns }, rows: [ array-mode rows ] }
```

Cookie/SSO auth, no extra header. `deptNumber: [-9999]` = all; `[93]` etc. per
dept. timeType 100 = day; returns ~61 daily rows ending **yesterday**.

Columns that matter: `timeText`, `purchasesCostAmt_Ty454`, `purchasesAmt_Ty454`
(retail), `salesCostAmt_Ty454`, `salesAmt_Ty454` (retail), `inventoryAmt_Ty454`.

Window = last inventory date (last Tuesday of the month) through today; sum the
daily rows. Verified dept 93, 2026-08-25..now: purchases cost $388,001.77,
sales retail $478,479.34, sales cost $341,493.10.

RESOLVED: row 13 = `salesAmt_Ty454` (retail). Dept 93 over the window: retail
$478,479.34 vs cost $341,493.10 = 28.6% margin, matching the ITR's own
`salesAmtMarginPct` (~26-31%/day). COGS is built from cost figures, so only
retail sales make `Sales - COGS` a real gross profit.
RESOLVED: window = **fourth Tuesday of the month** (NOT the last Tuesday — they
differ in 5-Tuesday months: Sept 2026 is the 22nd vs the 29th, Dec 2026 the 22nd
vs the 29th). Anchor = the most recent fourth Tuesday strictly before today,
inclusive of that date, through today. On 2026-09-22 (itself an inventory day)
that gives 2026-08-25 .. 2026-09-22.

## 3. Last night's MP/FDD freight — GDP Connect, BigQuery

**This does NOT go in worksheet row 8.** Row 8 (Warehouse Truck Invoices) is
always zero: the counted ending inventory stands on its own and last night's
freight is not added to it. The figures below are reported beside the sheet as
"Unfinalized Trailer totals" — trailer by trailer, broken down by department,
subtotalled for MP and for FDD.

Dashboard `https://gdp-connect.walmart.com/user/projects/20/dashboards/351`
("Warehouse Details", project 20 `Warehouse_Detail_Report`).

Auth is **`Authorization: Bearer <JWT>`** (PingFed), not cookies — same capture
pattern as `safetyagent`'s `X-SafePass-Token` webRequest filter.

```
POST https://api-manager-next.gdp.api.walmart.com/v1/datasource/user/execute-query
{ "datasetId": 1727, "visualizationId": 2268, "dashboardId": 351,
  "queryExecutionRequest": { "queryParams": {
      "nextGenFilters": "",
      "legacyParams":           { Store_Nbr, Dept_Nbr, Invoice_Nbr, Trailer_Nbr,
                                  start_date, end_date, limit, offset },
      "dashboardRunTimeParams": { ...same... },
      "datasource": { "project": "bq_us_gg_shrnk_prod", "datasourceType": "BIGQUERY" },
      "visualizationFilterDetails": "", "nextGenSqlParams": {} },
    "projectId": 20, "datasourceType": "BIGQUERY",
    "daasDatasourceId": "bq_us_gg_shrnk_prod" } }
```

**GOTCHA:** `limit`/`offset` must appear in `legacyParams` too, not only in
`dashboardRunTimeParams`. Omitting them yields a 500 from
`generate-executable-query` ("Expected ... but \"N\" found" — the AST parser
choking on the unsubstituted LIMIT). Blank strings for the other params mean
"no filter".

dataset 1727 = `FreshCostDeptsTrailer` over
`wmt-us-gg-shrnk-prod.ww_ap_vm.dc_warehouse_line_item_freight_line`, already
grouped to exactly what the sheet wants — one row per invoice date × trailer ×
dept, hard-filtered to depts 80/93/94/98:

```
INVOICE_DATE, Trailer_Number, store_nbr, DEPT_NUMBER,
nbr_of_Invoices, freight_charges, total_quantity,
Total_Cost, total_cost_and_freight_charges
```

Verified store 1458, 2026-09-15..22 → 49 rows (e.g. 2026-09-21 trailer 322594
dept 80 = $526.26 cost, $539.34 with freight). This replaces the manual
"page through line items and add them up" loop entirely.

Other datasets on the same dashboard: 1716 `FreshCostDeptsTrailerInvoice`
(same but per invoice, `dc_warehouse_line_item`), 126 `Warehouse Store Detail`
(`SELECT *` line items), 1715 trailer list, 1010 dept list, 122 aggregate by DC.

**RESOLVED: the trailer panel reports `Total_Cost`, freight charges excluded.** Verified against the
store's manual method (dataset 126 "Warehouse Store Detail", summing the
`Cost_Amt` column): store 1458 / dept 93 / trailer 309178 / 2026-09-20 returns
28 line items on invoice 6062030136 summing to $1,677.23, vs `Total_Cost`
$1,677.35 (the 12c is per-line rounding in the detail view; the aggregate sums
full precision) and $1,719.06 with freight.

**GOTCHA: `Trailer_Nbr` is a STRING column** — pass it quoted
(`Trailer_Nbr: "'309178'"`). Unquoted yields
`No matching signature for operator IN for argument types STRING and {INT64}`.
`Store_Nbr` and `Dept_Nbr` are INT64 and must stay unquoted.
OPEN: are CaseVisibility trailer numbers still needed, given we can filter by
invoice date alone? (A trailer arriving overnight may be invoiced the prior
day — the CV trailer list is the cross-check.)

## 4. Trailer numbers — CaseVisibility (REQUIRED, not optional)

`https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html`.
Same MAIN-world read as `modules/stockingplan/service.js`: fill `#inpStoreNbr` /
`#inpDate`, call the page's own `main_search()`, wait for `#divImgProcessing`,
then read `main_json.sdl`. Do NOT `window.open` CV's child pages (focus steal).

**CV's `trailer_id` IS GDP's `Trailer_Nbr`** (verified 2026-09-21: MP 322594,
FDD 309178 appear in both). `load_id` is a different number and matches nothing
in GDP. `shipment_type` carries `MP`, `MPDD`, `FDD` for fresh, plus `RDC`,
`HVDC`, `MILK`, `CANDY` for everything else.

**Why this source cannot be skipped:**

1. GDP does not label MP vs FDD, and cannot — both ship from the same
   perishable DC (6062 for 1458), so `DC_Nbr` does not separate them.
2. Invoice date is not delivery date. FDD trailer 309178 arrived on the night
   of 2026-09-21 but is invoiced 2026-09-20, so an invoice-date filter on the
   delivery night drops it — which is exactly why Bakery read $0.00 in the
   first probe. Filtering by TRAILER over a wide date window is correct;
   filtering by date is not.

## 5. Still unmapped

- Row 7 **Cost Inventory App total (cost)** — candidate:
  `https://ci-ops-dashboard.inventory-auditing.prod.k8s.us.walmart.net/`
  ("Cost Inventory Day Report - Backroom & Salesfloor Counts Only").
- Row 9 **Claims (cost)** — process doc says email proploss@wal-mart.com and
  the local DC; probably a manual entry field.
- Row 10 **Fuel Station/Convenience** (Deli column only).

## Probe scripts

`dev/costinv-probe*.mjs`, `dev/itr-probe*.mjs`, `dev/gdp-probe*.mjs` — all drive
the debug Edge over CDP (port 9222).


---

## 6. What was built (module `costinventory`, 2026-09-22)

Registered in `modules/_registry.js`; `manifest.json` gained
`gdp-connect.walmart.com` and `api-manager-next.gdp.api.walmart.com`.

| Worksheet input | Source | Path |
|---|---|---|
| C3 store, E3 date | typed / derived | `lib/dates.js` |
| row 7 Cost Inventory App | **typed by hand** — phone app, exists only on the day | grid input |
| row 8 truck invoices | **always 0** — freight is reported, never added (below) | `lib/compute.js` |
| rows 9, 10 claims + fuel | **retired** — the app handles both; exported as 0 | `lib/compute.js` |
| "Unfinalized Trailer totals" panel | GDP 1727 `Total_Cost`, trailers from CV | `lib/gdp.js` + `lib/casevisibility.js` |
| row 13 sales (retail) | ITR `salesAmt_Ty454` | `lib/itr.js` |
| row 14 beginning inventory | OneWalmart lookup tool | `lib/onewalmart.js` |
| row 15 purchases (cost) | ITR `purchasesCostAmt_Ty454` | `lib/itr.js` |

Export patches the store's own workbook (`templates/worksheet.xlsx`) rather
than rebuilding it: `lib/xlsx.js` inflates the zip with
`DecompressionStream("deflate-raw")`, writes the 25 input cells keeping each
cell's style index, strips cached formula values, sets `fullCalcOnLoad`, and
rezips with STORED entries (no deflate implementation needed; ~54 KB out).
Dates go in as Excel serials because E3 is styled numFmt 14.

### Runtime gotchas found while wiring it up

- **The GDP query API cannot be called from the extension origin.** With
  credentials the walmart.com cookie jar rides along and the gateway answers
  **431 Request Header Fields Too Large**; with `credentials: "omit"` it
  answers **403 Invalid CORS request**. The POST therefore runs inside a
  gdp-connect.walmart.com tab via `executeScript({ world: "MAIN" })` — the tab
  is the transport, not an optimisation. ISOLATED world does not help: content
  script fetches are extension-origin for CORS purposes.
- **Frozen tabs hang `executeScript` forever** — it never resolves and never
  throws, so the pull spins until the user gives up (this cost two debugging
  rounds; same trap as the vizpick capture tabs). Every `executeScript` here
  goes through `lib/timeout.js::withTimeout`, GDP always opens a FRESH tab, and
  an existing CV tab is reused only after `tabResponds()` answers.
- **Do not wait on `chrome.tabs.get().status === "complete"` for CV** — it
  holds a request open and can sit at "loading" while fully usable. Poll for
  `#inpStoreNbr` instead.
- **An ISOLATED-world probe cannot see page globals.** Checking
  `typeof window.main_search === "function"` from the probe reads undefined
  forever; the DOM is shared but globals are not.
- **`browser.pages()` over CDP hangs** when a frozen tab is present — close
  strays with `/json/close/<id>` instead (dev scripts only).

### Verified live (store 1458, 2026-09-22)

Beginning inventory 93/80/94/98 = 71,320.61 / 14,929.09 / 38,781.29 /
27,599.94 · window 2026-08-25 → 2026-09-22 (ITR publishes through yesterday) ·
freight MP 322594 $23,462.68 + FDD 309178 $3,554.53 = $27,017.21, per dept
15,354.64 / 1,183.11 / 9,314.82 / 1,164.65 · export downloads a valid 54 KB
workbook with all 22 value cells written and the sheet's formulas intact.

### Open

- Row 7 stays manual by design. If the Cost Inventory App ever exposes an API,
  that is the one remaining pull.
- Not yet exercised on a store other than 1458, or on a month where the
  lookup tool has rolled over to a new toolId.
