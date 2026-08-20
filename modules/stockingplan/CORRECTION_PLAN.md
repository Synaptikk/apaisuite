# StockingPlan — Correction Plan (v2, evidence-based) 🐶

**Scope:** Data collection works. Bugs are in **computation & display** —
freight totals + aisles. Associate detection is fine (parked).

**MAJOR UPDATE:** I pulled CaseVisibility's *own* public JS
(`calc.js`, `config.js`, `casesByDept.html` — all served without auth, only the
runtime *data* needs login). We now have the **authoritative algorithm**. The
extension's math is invented and does not match CV. This rewrites the plan.

---

## §0 — Verified delivery totals (from Shane's paste, store data 7/27–7/28)

Case Summary / Delivery table columns:
`ETA | Type | Trailer | Load ID | Groc/Cons | GM | Bkpk boxes | Total`

| Groc/Cons | GM | Bkpk | Total |
|---|---|---|---|
| **7,782** | **1,400** | **217** | **9,399** |

Rule confirmed by owner + math: **Total = Groc/Cons + GM + Bkpk** (additive),
and **bkpk boxes contain inner packs**. All six rows + footer reconcile. ✓

---

## §1 — 🔴 THE BIG ONE: hours math is completely wrong

### What CaseVisibility *actually* does (from `calc.js` + `config.js`)

**Per-department CPH (cases-per-hour), NOT flat buckets.** Every dept has its
own rate in `config_deptListing`. Examples:

| Dept | Name | CPH |
|---|---|---|
| 4 | Household Paper | 90 |
| 56 | Live Plants/Garden | 99 |
| 92 | Dry Grocery | 47 |
| 95 | DSD Grocery | 47 |
| 90 | Dairy | 48 |
| 91 | Frozen Foods | 50 |
| 2 | HBA | 48 |
| 40 | OTC | 55 |
| 13 | Household Chemicals | 55 |
| 77 | Large Appliances | 30 |
| 17 | Home Décor | 35 |
| ...| (66 depts total) | 30–99 |

- **Default CPH = 65** when a dept isn't found (`config_defaultStockingCPH`).
- **Vendor-set depts get 0 hours:** `config_deptVendorSet = [21]` (Books).
- CV prefers live workforce-planning rates (`main_json.cph`) and **falls back**
  to `config_deptListing` — so hardcoding the listing is a safe baseline.

**The hours formula** (`calc_getStockingHoursByDept`):
```
stockingHours = totCases / cph[deptNbr]
```
And critically, in `casesByDept.html._buildTBody`, cases and inner-packs (bkpk)
are **each** run through the **same per-dept CPH**:
```
casesHours = calc_getStockingHoursByDept(full_cases, dept)   // full_cases / cph
bkpksHours = calc_getStockingHoursByDept(inner_packs, dept)  // inner_packs / cph
totalHours = casesHours + bkpksHours
```

### What the extension does (WRONG) — `lib/compute.js`
```js
const FOOD_CONS_RATE = 55;   // ❌ invented
const GM_RATE        = 45;   // ❌ invented
const INNER_PACK_RATE = 80;  // ❌ invented — CV has NO flat 80/hr rate
const FOOD_CONS_DEPTS = new Set([4,8,13,2,46,40,92,95,90,91]); // ❌ ad-hoc

hoursForTask = cases/rate + innerPacks/80;  // ❌ wrong on every term
```
Every rate, the dept grouping, AND the formula are wrong. This is the primary
cause of "freight totals are wrong."

### Fix
1. Port `config_deptListing` (66 depts + CPH) into a data table in
   `lib/compute.js` (or a new `lib/cvRates.js` for cohesion).
2. Add `config_deptVendorSet = [21]` → 0 hours.
3. Add `DEFAULT_CPH = 65`.
4. Rewrite `hoursForTask(fullCases, innerPacks, deptNbr)`:
   ```js
   const cph = CPH[deptNbr] ?? DEFAULT_CPH;
   if (VENDOR_SET.has(deptNbr)) return 0;
   return roundUpHalf((fullCases + innerPacks) / cph);
   ```
   (Both cases and inner packs divided by the SAME dept CPH — matches CV.)
5. Keep the "round up to nearest 30 min" as a *stocking-plan* preference (that's
   the extension's own choice; CV shows HH:MM). Confirm with owner.

---

## §2 — 🔴 Data granularity: extension scrapes the wrong table

CV's real per-dept numbers live in **`psn_apiJson`** — a
LZString-compressed blob in `sessionStorage` under key **`fpt_psnAPIJson`**.
Shape: `psn_apiJson[].shipment_details[] = { dept_nbr, full_cases, bkpk_units }`
(bkpk_units = **inner packs**). `casesByDept.html` decompresses this and rolls it
up per dept via `calc_getCountsByDept(loadID, deptNbr)`.

The extension instead scrapes `#summaryTableByArea` (coarse category rollups)
off the main page and maps two columns positionally → can't produce a real
per-dept plan, and mislabels inner packs.

### Fix options (need owner nod — §7 Q1)
- **Option A (accurate, preferred):** In `service.js` MAIN-world script, read
  `sessionStorage.getItem("fpt_psnAPIJson")`, `LZString.decompress` it, and roll
  up per-dept exactly like CV. Gives true per-dept cases + inner packs → feed the
  corrected `hoursForTask`. This is how CV itself does it.
- **Option B (quick):** Keep scraping the rendered `casesByDept.html` tables
  (Total Cases / Total Breaks columns) after opening that page — less code, but
  depends on DOM staying stable.

---

## §3 — 🔴 Aisles (owner wants food aisles — confirmed) — REAL ALGORITHM FOUND

Pulled `casesByAisle.html`. The extension's `pairAisles()` (pair adjacent aisle
numbers 8+9, 10+11…) is **pure fiction** — that's NOT how CV builds aisles. The
real algorithm:

**Scope:** aisles are **ONLY** depts **92 (Dry Grocery) + 95 (DSD Grocery)** —
`gv_locDeptNbrs = [92, 95]`. Page title literally: "D92/95 Cases by Aisle".

**Two data sources combined:**
1. `psn_apiJson` (sessionStorage `fpt_psnAPIJson`, LZString) — shipment details
   with `{ gtin_nbr, dept_nbr, full_cases, bkpk_units }` per load.
2. **A separate AJAX call** — this is the missing piece:
   ```
   ../ashx/AisleLocation.ashx?func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=<n>
   ```
   Returns `{ aisles: [{zone, aisle}], locations: [{dept_nbr, upc_nbr, zone, aisle}] }`
   i.e. a **UPC → zone/aisle** map.

**How CV computes each aisle row (`locBuildTBody` / `_buildCaseCountsAndTimeRows`):**
- For each `{zone, aisle}`: gather UPCs at that location (`_getUPCArray`).
- `calc_caseCountsAndHoursByUPC(loadID, upcs)` → sums `full_cases` for matching
  UPCs and hours = `full_cases / config_getCPH(dept)`.
- Aisle label = `zone + aisle` (e.g. `A12`). Rows with 0 cases are hidden.
- **Shipment-type filter:** only
  `["RDC","HVDC","MP","MPDD","F","FDD","MK","MILK","CANDY"]`.
- **Footer** sums per-dept `(full_cases + bkpk_units) / cph` for depts 92,95.
- UPCs with no aisle location → "unknown locations" bucket.

### Fix
- Delete `pairAisles()` — it's wrong.
- In `service.js`, after reading `psn_apiJson`, also fire the `AisleLocation.ashx`
  request (via the content script, `credentials:include`) to get the UPC→aisle
  map, then roll up per aisle exactly like CV.
- Feed `aisleSections` with `{ label: zone+aisle, cases, hours }` rows for D92/95.
- Respect the shipment-type allow-list and hide zero-case aisles.

⚠️ This needs one live sample of `AisleLocation.ashx` output to confirm the JSON
shape (`aisles` / `locations` arrays) — see §7 Q4.

---

## §4 — 🟠 Dept grouping for F&C vs GM labels

CV's real rollups (`config_storeArea`):
- **Groc/Cons** = `config_deptGroc` [1,80,81,82,90,91,92,93,94,95,96,97,98]
  + `config_deptCons` [2,4,8,13,40,46,79]
- **GM** = Fashion, Hardlines, Homelines, Entertainment, Seasonal, Other
  (all remaining depts, enumerated in config).

Replace the extension's ad-hoc `FOOD_CONS_DEPTS` set with these real groupings
so the F&C/GM tag and any grouping matches CV exactly.

---

## §5 — 🟠 Summary/footer rows leak in as data (Bug B, still valid)

- `#summaryTableForDeliveries` loop only skips the `'Delivery ETA'` header — the
  **footer totals row** (`7,782 | 1,400 | 217 | 9,399`) will be ingested as a
  fake truck. Add a footer/total-row filter.
- `#summaryTableByArea` loop: a `Total`/`Grand Total` row slips through the
  non-numeric-first-cell check. Add `SUMMARY_RE = /^(grand\s*)?total|^summary/i`.

(If we move to §2 Option A, the delivery-table scrape stays but must still filter
its footer.)

---

## §6 — 🟡 Cleanup

- [x] Remove `=== JOB FIELD ANALYSIS ===` console spam in `buildPlan` (compute.js).
- [x] Remove dead `"get-last-plan"` handler (service.js).
- [x] Move `explore-cv-tables.js` / `test-cv-fields.js` into `tools/`.

---

## ✅ BUILD COMPLETE (2026-07-28)

All sections done and verified against the live capture (`node tools/verify-compute.js`
→ 12/12 pass):

- [x] §1 real per-dept CPH + `(cases+inner)/cph` formula → `lib/cvRates.js`
- [x] §2 data source: `sessionStorage.fpt_psnAPIJson` decompress in `service.js`
- [x] §3 aisles: real D92/95 rollup via `aisle_loc` (+ AisleLocation.ashx fallback)
- [x] §4 real Groc/Cons + GM groupings
- [x] §5 delivery footer-row filter (Bug B)
- [x] §6 cleanup + dev scripts moved to `tools/`
- [x] §2 two-tier CPH (`main_json.cph` → static fallback)
- [x] Exact HH:MM output (no rounding) via `decToHHMM`

**Verified reconciliation:** Groc/Cons 7,782 · GM 1,400 · Total 9,182 cases ·
2,742 inner packs · aisle rollup ties to D92/95 total exactly.

---

## §7 — Questions before I start editing code

1. **Per-dept data source:** OK to read `sessionStorage.fpt_psnAPIJson` +
   LZString decompress (§2 Option A, accurate)? Or stay DOM-scrape (Option B)?
2. **Rounding:** Keep "round up to nearest 30 min" per task, or match CV's exact
   HH:MM? (CV does not round.)
3. **Live CPH override:** Use `main_json.cph` (workforce planning) when present
   like CV does, falling back to the config listing? (Recommended — most
   accurate. It's also in sessionStorage as `fpt_mainJson`.)
4. **Aisle sample:** Can you grab one live response of
   `AisleLocation.ashx?func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=<n>`
   (Network tab → Preview) so I can lock the JSON shape before coding the aisle
   rollup? Not a blocker for §1/§2, only for §3.

---

## §8 — Execution order (once §7 answered)

1. Add real CPH table + groupings (`lib/cvRates.js`).
2. Rewrite `hoursForTask` + F&C/GM classification (§1, §4).
3. Wire per-dept data source (§2).
4. Pull `casesByAisle.html` JS, implement aisle scrape (§3).
5. Footer/summary-row filters (§5).
6. Cleanup (§6).
7. Verify: dept totals reconcile to Groc/Cons 7,782 · GM 1,400 · Bkpk 217 ·
   Total 9,399, and hours match CV's casesByDept page.

---

### Evidence sources (all public, no auth)
- `…/CaseVisibility/js/calc.js?version=2.0` — hours + count logic
- `…/CaseVisibility/js/config.js?version=2.3` — dept CPH listing, groupings,
  constants (`config_defaultStockingCPH=65`, `config_deptVendorSet=[21]`,
  `config_unloadCPH=175`)
- `…/CaseVisibility/html/casesByDept.html` — how CV builds the per-dept tables
