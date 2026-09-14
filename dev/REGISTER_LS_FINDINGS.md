# Register Long/Short — source findings

Probed 2026-09-12 over CDP against the debug Edge (read-only: list/detail
loads, one EJ search, one Cash Research Search reload). Store 1458.

Three sources feed register long/short triage. Power BI was already wired
(`modules/livedashboard/lib/sources/register.js` + `content/powerbi_register_capture.js`);
this doc adds APPRISS WorkView and EJ, and records how each page is
navigated so the module can drive them.

---

## 1. APPRISS WorkView — the queue of items to disposition

**Page:** `https://apps.apprissretail.com/walmart-usa/platform/workview#/list?viewType=unassigned&sorting=priority:desc&fromDate=<ISO>&toDate=<ISO>&hierarchyId=1&hierarchyLevel=0&hierarchyLocation=<store>`

Manual navigation: Workview → "New Work Items" list. Parameters bar =
Order By (priority), Date Range, Location Hierarchy (store). Each card has
`View` (read-only detail) and `Start Work` (assigns to you, then
`Disposition` and `Add Work Item to Investigation` become the actions).

### List API (V)

```
POST https://apps.apprissretail.com/walmart-usa/platform/workview/api/v2/workviewItems
Content-Type: application/json   (session cookie; same-origin fetch works from the page)
{
  "status": "unassigned",                      // viewType
  "fromDate": "2026-08-14T00:00:00", "toDate": "2026-09-12T23:59:59",
  "include": [], "filterTerms": [], "subjects": [],
  "locationHierarchy": { "hierarchyId": 1, "level": 0, "levelCode": "1458" },
  "sortField": "priority", "sortDirection": "descending",
  "sourceApp": null, "category": null, "startIndex": 0
}
→ { success, data: { items: WorkItem[], totalResults, totalResultsIncludingStackedItems, endIndex, dataPolicies } }
```

**Paging + views (recorded 2026-09-12).** 20 items per page. `totalResults`
is only on the first page; every page's `endIndex` is the next page's
`startIndex` (pages at 0 and 19 gave 40 distinct ids). `status` accepts only
`"unassigned"` (the "New" view) and `"assigned"` (in progress); `all`,
`open`, `mine` are 400. The date range is a real filter: store 1458 had 6
unassigned items in the last 30 days but 86 going back to 2026-07-02, of
which 14+ are `overshort` "Cash" items with **overages** as well as
shortages. The module pulls both views, all pages, two years back.

`WorkItem` fields that matter:

| field | example | note |
|---|---|---|
| `id` | `14671175` | work item id; detail URL `workview#/detail/<id>?id=<id>` |
| `sourceAppId` / `sourceApp` | `"mel"` / `"High Impact"` | MEL = Master Exception List. `"overshort"` / `"Long/Short"` is the other L/S source |
| `category` | `"Action Required: Long/Short Item"` | also `"SCO Cash Advance within Cash Shortage Amt"` (overshort), and non-L/S noise: Refunds SASC, Missed Scan, WIN Match |
| `subjects[]` | `{key:"vision_mel_master_unique_id", value:"1458\|63\|2026-08-16\|30"}` | **store \| register \| business date \| abs amount** — the join key to Power BI and EJ |
| `cardSections[]` | `Date 8/16/2026`, `Store 1458`, `Item Amount -30.00` | signed amount; negative = short |
| `potentialValue` | `"$30.00"` | |
| `statusID` / `statusType` | `0` | unassigned |
| `priorityID` | `3` | High |
| `isOverDue`, `targetResolutionDateTime` | | SLA |
| `createdDateTime` | | items generate **up to 11 days** after the L/S (banner on the page) |
| `virtualFilePath` | `/system/ebr/instant analytics/definitions/cash research/register long_short.fti` | |

### Detail API (V)

```
GET  /walmart-usa/platform/workview/api/v1/workviewItem?workItemId=<id>      → { data: { workViewItem } }
GET  /walmart-usa/platform/workview/api/v1/getCustomAnalysisResults?workviewId=<id>
POST /walmart-usa/platform/workview/api/v1/getFtiByWorkview  {"workviewID":"<id>"}
```

Detail page text ("Work Item Analysis"): *"Store 1458 has a discrepancy on
Register 63 in the amount of -81.00 on 8/27/2026. … Fraud or non-process
driven conclusions please reassign the work item exception to Asset
Protection for review."* Supporting searches offered: **Open Drawer**,
**Cash Research Search**, **CFTs by Date**.

### Disposition flow (V — recorded 2026-09-12 up to, not including, Complete)

```
Start Work   → POST /walmart-usa/platform/workview/api/v1/assignToSelf  {"workViewId":14689989,"actionAllItemsInStack":false}
               (then POST checkworkitempermission, GET source-apps; button becomes "Assigned to you")
Disposition  → AngularJS lightbox "Disposition Work Item":
               <sng-filterbox data-qa-id="wv-abandon-filterbox-<sourceAppId>"   ← reason picker
                   search-path="/system/workview/search/abandonreasonsselect.search"
                   opened by its [ng-click="open()"] child; options are <ul><li> rows
                   loaded via POST /walmart-usa/platform/cpf/controls/filteredselectavailable
                   {"virtualFilePath":"/system/workview/search/abandonreasonsselect.search","filter":"",
                    "startIndex":0,"labelField":"label","valueField":"value",
                    "parameters":[{"name":"sourceApp","value":"mel"}],"multiple":false}
               <textarea id="wv-abandon-reason">                                   ← "More Information"
               buttons: Cancel, Complete
Complete     → NOT recorded (never clicked). Unknown endpoint.
```

The reason list depends on the work item's source (fetched with
`POST /walmart-usa/platform/cpf/controls/filteredselectavailable`, paged 10
at a time, parameters `[{name:"sourceApp", value:<sourceAppId>}]`):

- `mel` (Action Required: Long/Short Item): Cash Card Scam (70), Counterfeit
  Bills (71), Internal Theft (72), Multiple Reasons (73), Not Identified (74),
  Phone Scam (75), Process Errors (76), Quick Change (77), Robbery (78).
- `overshort` (Long/Short - Cash): Process Error - Till Check-Ins (50), Cash
  Advances (51), Cash Pickups (52), Drop Vault (53), Content Out of Balance
  (54), Lottery (55), Cashier (56), CFT (57), SCO Down (58), Recycler
  Down/Connectivity (59). No theft outcomes — the item is reassigned to AP
  for those.
- `store` (Secure Store exceptions): Unable to Investigate (1), Non Malicious
  (2), Moved to Watchlist (9), Missed Scan - Host Recovered (10), Missed Scan
  - False Alert (11).

The module (`lib/reasons.js`) files flips as Process Errors (mel) / Process
Error - Till Check-Ins (overshort), bouncebacks as Process Error - Content
Out of Balance (overshort), advance-carried flips as Process Error - Cash
Advances, and drives the form through `lib/dispo.js` (`Start Work` →
`Disposition` → type the reason into the picker's Filter box → pick → fill
More Information → **Complete**) in a background tab that is closed again,
after the analyst verifies reason + text in the module's dialog. The Complete
click is confirmed by the lightbox disappearing; the item is then dropped from
the cached queue and logged under `registerls.completed`. A dry-run mode
(fill → Cancel) exists for testing.

**Who swapped the tills (flips).** For a flip pair the till log's check-ins on
both registers that day name the person: one associate checking in both =
the swap is theirs (charged in the cashier ledger as "flipped check-ins");
two different people = both named, neither charged. SCO registers usually
have no till check-ins at all (recycler), so those pairs stay unattributed.

### Cash Research Search (V) — 10-day register cash ledger

Explorer search, same endpoint AurorBuddy already uses
(`modules/aurorbuddy/lib/appriss_http.js::SEARCH_URL`):

```
POST https://apps.apprissretail.com/walmart-usa/platform/cpf/searchlite/getsearchresults
{
  "searchVirtualFilePath": "/public/work items/supporting searches/cash research search.search",
  "builderVirtualFilePath": "", "presentationType": "grid", "startIndex": 0,
  "sortColumn": "", "pageSize": 0, "sortOrder": "none", "disableDrill": false,
  "filter": "", "forceRun": false, "showFullLoader": false, "conditionsToSkip": [],
  "preventRunningWhenNonRequiredParameterisedConditionsHaveMissingValues": true,
  "parameters": {
    "searchPath": "/public/work items/supporting searches/cash research search.search",
    "dailyreconciliation_storeno": "1458",
    "dailyreconciliation_posno": "63",
    "dailyreconciliation_tradingday": "10", "dailyreconciliation_tradingday1": "day",
    "builderPath": "/system/ebr/overshort/builder/overshort.builder"
  },
  "rowData": {}, "canOfferRerun": true
}
→ { data: { headers: {colId: {cellValue: "Trading Day", …}}, rows: [ {colId: {cellValue, rawValue}} ] } }
```

Columns per trading day: Trading Day, Store No, Register, Reading, Expected
Cash, Reading EBT, Reading Check, Manufacturer Coupon, **Cash Long/Short
Amount**, **Finalized Long/Short Amount**, Cash Advances, Cash Pickups, Till
Checkouts, Till Checkins. Search model also exposes an amount filter
(`dailyreconciliation_overshortamount` −19.99 … 19.99 default band) and
the hierarchy data policy. Row limit 1000.

---

## 2. EJ Viewer — every transaction on a register for a day

**Page:** `https://ej.walmart.com/` (PingFed SSO). Form: Country*, Site
Number*, Operator Number, Transaction Number, Register Number, Date*
(`mm-dd-yyyy`, input `#date`), TC Number, Start/Stop Time, `#searchSubmitID`.
Input ids: `#siteNumber`, `#registerNumber`, `#operatorNumber`,
`#transactionNumber`, `#tcNumber`, `#startTime`, `#stopTime`. Results render
as receipt cards ("39 of 70 records"), with Options: Show Only Tax Exempt,
Hide Sign On/Sign Off, Hide End of Day Sales, Show Revenue; date paginator
arrows step the day.

### API (V)

```
GET  https://ej.walmart.com/api/v1/refresh-pingfed-tokens         (page does this on load)
GET  https://ej.walmart.com/api/v1/isp-token
     → { status:"OK", data: { userId, displayName, roles:["EJ_NPCI_USER"],
                              ispToken: "<~2.8 KB bearer>", exp: "<epoch s>", tokenType:"Bearer" } }
POST https://ej.walmart.com/api/v1/receipts/US/<site>/<MM-DD-YYYY>
     headers: content-type: application/json
              accept: application/json, text/plain, */*
              correlation-id: <uuid v4>          ← mandatory; without it: 400 "Missing Mandatory headers"
     body:    { "isp-token": data.ispToken, "currentDate": "<today MM-DD-YYYY>",
                "registerNumber": "63", "transactionNumber": "", "operatorNumber": "",
                "tcNumber": "", "startTime": "", "stopTime": "" }
→ { records: [ { transTime: 112707, opNum: 5638, transNum: 9973, tcNum: "9817…",
                 termNum: 63, index, is16?: true /*sign on/off*/, isEOD?: true,
                 record: "<receipt text>" } ] }
```

The date in the URL is the business day searched; `currentDate` is just
today. Filters left empty return the whole store-day (the date paginator
does exactly that), so `registerNumber` is what scopes a pull to one till.

`record` is the printed receipt. Reliable anchors inside it:
`ST# 1458 OP# 00005638 TE# 63 TR# 09973`, item lines, `SUBTOTAL`, `TOTAL`,
tender lines (`CASH TEND 200.00`, card tenders, `CHANGE DUE 4.00`),
`** VOIDED ENTRY **`, `TC# …`, trailing `MM/DD/YY HH:MM:SS`. Non-sale
records: `SIGN ON CLOCKED IN` / `AUTOMATIC SIGNOFF` (with operator name),
`TERMINAL IDLE`, `END OF DAY SALES`, `REFRESH TERM CONFIGURATION`.
`transTime` is HHMMSS as an integer.

The EJ tab was left showing the probe search (site 1458, reg 63, 08-16-2026).

---

## 3. Power BI long/short report — already wired

Report `65c97d6a-7ad8-498d-b752-69028d408993`, slicers: OP # (4 Digit),
Store (4 Digit), POS #, Date, Filter Amounts. The livedashboard source
captures the report's own `qryLongShortSignOn` QES queries (grid = register
× date × `long_short_amt`; operator = per-shift `Operator_Nbr`), can swap the
store filter and replay in-tab, decodes DSR, and runs matching (R1
unmatched, R2 nearby-register offset, R3 same-register bounceback) with a
`flipConfidence` score. See `docs/live_dashboard_backend/RISK_RULES.md §5`
and `DATA_CONTRACTS.md §5`. `CURRENT_TASKS.md §2` was corrected 2026-09-12.

**Date window (recorded 2026-09-12).** The grid and operator queries filter
`qryLongShortSignOn.action_date` with an `In` clause holding one explicit
`datetime'YYYY-MM-DDT00:00:00'` literal per day — not a range. The capture
holds exactly what the report's Date slicer held (19 days, 2026-08-24 →
09-11, on the first run), so replays returned 8/25–9/11 and anything older
had "no cell". `fetchRegister(storeNbr, { days, endIso })` now rebuilds that
list to `days` consecutive days ending at `endIso`; `registerls` asks for 60.
The source keeps roughly 60 days (older days simply come back empty).

---

## How the three join

Key = `(store, register, businessDate)`.

- WorkView gives the **queue** (what must be dispositioned, with SLA) and
  the amount as APPRISS finalized it.
- Power BI gives the **whole grid** (every register × day, including the
  overages that WorkView never raises), which is what makes offset/flip
  detection possible.
- Cash Research Search gives the register's **10-day cash ledger** (advances,
  pickups, till check-in/out counts) for the same register.
- EJ gives the **transactions** for the register-day: operators signed on,
  and whether a cash tender of about the shortage amount exists (a single
  matching cash transaction is the "go watch the video" signal).

---

## 4. Power BI "Cash Recycler" report — till check-in/out log (recorded 2026-09-12)

**Page:** `https://app.powerbi.com/reportEmbed?reportId=59fc9ae6-9d65-4277-b2f6-79fe4b5a10a4&autoAuth=true&ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d`
One page ("Cash Recycler"), one table, slicers Store / Register / Action
(all default "All"; store "Not yet applied"). Last updated shown in a card
(`Cash_Recycler.Report_Update`).

**Query (V).** Same QES endpoint family as the long/short report
(`pbidedicated.windows.net/webapi/capacities/<cap>/workloads/QES/Query`).
Entity `Cash_Recycler`, columns Store_Infor ("1458 - FORT OGLETHORPE, GA"),
Transaction_Date (epoch ms, midnight UTC), Transaction_Time ("01:05:13 PM"),
Register, Register_Desc, Associate_Name ("CDH00BJ CINDY CHRISTIAN" = WIN +
name), Action_Type, Payment_Amt, Cash_Amt (always 0 in the sample). Action
types seen: TILLCHECKIN, TILLCHECKOUT, TILLCHECKINOVERRIDE, ADVANCECASH,
VAULTFUNDADVANCECASH, CASHPICKUP. The table's own query has **no Where** and a
500-row window ordered by date desc.

**VAULTFUNDADVANCECASH is not a till advance.** Profiled on 1,069 events
(store 1458, 60 days): median $10.50, p95 $26, max $115.50, 56% carry cents
($5.50, $12.50…), 76% land within 3 minutes of an ADVANCECASH by the same
cash-office associate, concentrated on SCO registers, in the 7–11 AM sweep.
ADVANCECASH by contrast is whole dollars (median $93, p95 $1,875). Read: the
change-fund (coin) top-up that accompanies the bill advance. The rules use
ADVANCECASH only; the coin line is shown in the timeline and summed as
"change-fund advances".

**Replay.** Capture the table query (`modules/registerls/content/powerbi_cash_recycler_capture.js`),
then rewrite: add `Where` = Store_Infor Contains `'<store>'` + Transaction_Date
≥ `datetime'<from>T00:00:00'`, set `Binding.DataReduction.Primary.Window.Count`
to 5000, drop `CacheKey`; replay with the captured headers (Authorization
bearer etc.), `credentials:"omit"`, via the pre-patch `rawFetch`. A 5000-row
window still stops early (43 days ≈ 5000 rows for store 1458) and returns
`DS[0].RT` restart tokens; page by putting them in `Window.RestartTokens`.

**Decode.** `DS[0].PH` has two blocks: `PH[0].DM0` is the subtotal (A0/A1);
the detail rows are `PH[1].DM1` with the G0…G6 schema — hand that block to
`digitallocks/lib/dsrDecode.js::decodeDsr` as if it were DM0.

**Rules built on it** (`modules/registerls/lib/till_events.js`): a cash advance
to the short register near the amount that shows up as an overage on any
register within ±1 day = advance carried to the wrong till (a far-register
flip, nothing found, coach the associate); the same advance with no overage
anywhere = the money may never have reached the till (suspect the carrier);
a till moved between registers = an ORPHAN pair on the day (register X with a
check-out that never came back, register Y with a check-in never checked out,
within 3 h and ±$50), charged to whoever did the check-in on Y — pairing a
person's consecutive check-out/check-in flags cash-office staff issuing tills
and was wrong; the same
associate checking a till out and back in within 15 min with less cash = a
"quick re-check-in" (reg 63 on 2026-08-27: $1,462 out 20:32, $1,362 in 20:34).

First live pull (store 1458, 60 days): 6,527 events, 3 tills moved between
registers, and two shortages re-classified as advances carried to the wrong
till (reg 6 $99.99 on 09-02 ↔ reg 26 over 09-01, $100 advance; reg 19 $21 on
07-18 ↔ reg 73 over 07-19, $21 advance).

### Open Drawer supporting search → transaction video (V — probed 2026-09-14)

Long/short work items carry no transactions (`getFtiByWorkview` →
`hasTransactions:false`), so WorkView shows no video for them. Video in
APPRISS is per transaction and keys on APPRISS's own `transactionid`, which
the EJ does not have. The "Open Drawer" supporting search on every L/S item
returns every transaction that opened the drawer on that register-day WITH
that id:

```
POST /walmart-usa/platform/cpf/searchlite/getsearchresults
  searchVirtualFilePath "/public/work items/supporting searches/open drawer.search"
  parameters { searchPath, storeno, posno, tradingday: "8/27/2026 12:00:00 AM" }
  pageSize 0 → 20 rows/page (lastRowIndex → next startIndex); pageSize 100 works
columns: storeno, storecashierno, posno, ticketno (= EJ TR#), ticketamount,
         tendercashamount, tenderchangeamount, tendercashbackamount,
         endtransdatetime "2026-08-27 13:05:01", transactionid "2608270040988382333"
viewers: /walmart-usa/video/react#/cameras?transactionId=<id>      (CCTV)
         /walmart-usa/platform/viewer?hidechrome=true#/store/ardm/event/<id>  (receipt)
         /walmart-usa/platform/viewer#/store/ardm/search/<id>       (transaction viewer)
```

`lib/open_drawer.js` pulls it during `analyze_item`; `evidence.js::linkVideo`
joins on TR# (fallback: end time within 90 s) and every cash match,
investigation candidate and red flag gets `video.cctvUrl/receiptUrl`. A
drawer open with nothing tendered and the shortage amount paid out is a
`cashout` signal (refund/payout of exactly the amount) — reg 63 08-27 $81
short: $76 paid out on TR# 371 at 18:56.

## 5. Power BI "Cash Fund Transfers" (reportId 22a4bd64-8f29-4be0-bf3a-15834366dee9)

One table, entity `CFT_Data`: BUSINESS_DATE, INPUT_DATE, INPUT_TIME
("1899-12-30T03:30:15"), CFT_ID, ACCOUNT_NBR / ACCOUNT_DESC, RECIPIENT_NAME,
CFT_REASON, CFT_AMOUNT, STORE. Slicer "Reset Filter" = 'Exclude Resets' is
kept on replay. **No register column** — a CFT can only be lined up with a
shortage by amount and date. Negative "System Generated" rows at 03:30 are
the recycler's own long/short postings (`system:true`, ignored by the rule).
DSR quirk: groupings G0..G7 then measures M0..M1, while the descriptor lists
Sum(CFT_AMOUNT) second — `cft.js::dsrColumnOrder` reorders before decoding.

Capture: `content/powerbi_cft_capture.js` (ring `__APAISUITE_REGISTERLS_CFT_CAP`,
table query = selects CFT_REASON + INPUT_TIME). Replay: Where = Exclude
Resets + STORE = <n>L + BUSINESS_DATE ≥ from, Window 5000. Store 1458,
60 days: 165 transfers. Rule (`evidence.js::cftMatches`): shortage only,
amount within tolerance, business or input date from a day before to a week
after the shortage → `cft` why bullet + table; `keyedLate` when input date >
business date. Never auto-filed.

**Correction (user, 2026-09-14):** CFT cash comes out of the cash recycler,
not out of a register, so a CFT near a register shortage is NOT a cause of
it; the `cft` why bullet was removed and the table is reference only. The
till log has no CFT dispense event (actions are only TILLCHECKIN/OUT,
ADVANCECASH, VAULTFUNDADVANCECASH, CASHPICKUP), and tying a CFT to a
same-amount advance is noise (advances are round daily amounts). Open: how
a late-keyed CFT surfaces as a shortage (recycler L/S? the register it was
keyed on?) — rule to be rebuilt once that is known.
