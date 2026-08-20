# CV Data — Confirmed Findings (live capture, Store 1458, 2026-07-28)

Captured via `tools/capture-cv-data.js`. Raw dumps in `tools/captured/`
(gitignored). This is the **ground truth** for the rebuild.

## 1. `psn_apiJson` — per-load, per-item freight detail
Source: `sessionStorage.fpt_psnAPIJson` → `LZString144.decompress` → `ajax3_toJson`.
It's an **array of loads**. 7 loads captured.

**Load object keys:**
`status, message, store_nbr, load_id, shipment_type, data_source,
refreshed_from_api, shipment_summary, shipment_details`

**`shipment_details[]` row keys (THE important ones):**
`dept_nbr, item_nbr, gtin_nbr, item_desc, retail_amt, pack_type, invoice_id,
item_qty, item_uom, retail_uom, whse_case_item_qty, full_cases, bkpk_units,
event_code, star_freight, aisle_loc`

Key fields for the plan:
- `dept_nbr` — department number
- `full_cases` — full cases (→ hours at dept CPH)
- `bkpk_units` — **inner packs** (breakpack units) (→ hours at dept CPH)
- `gtin_nbr` — UPC (string!) — used to join to aisle locations
- `pack_type` — "FULL" / (breakpack types) — informational
- **`aisle_loc`** — 🎁 BONUS: aisle already on the row! May let us skip the
  AisleLocation join for a first pass. Verify coverage vs the location map.

**`aisle_loc` coverage (measured):** D92/95 detail rows = 1,714;
with `aisle_loc` populated = **1,679 (98%)**. Sample values: A20, A8, A17, A23…
(same `zone+aisle` format as the location map). Decision: **use `aisle_loc`
directly for aisle rollup** (fast, no extra call), and fall back to the
AisleLocation UPC→aisle join for the ~2% blanks (matches CV, catches
"unknown locations").

**Loads captured (type · detail rows):**
| load_id | type | details |
|---|---|---|
| 113647345 | HVDC | 856 |
| 112739038 | Internalized Parcel | 0 |
| 113822382 | HVDC | 73 |
| 114140753 | MP | 370 |
| 113800376 | RDC | 1772 |
| 113800286 | RDC | 3681 |
| 113647285 | FDD | 1379 |

**Totals across all loads:** full_cases = **9,182** · bkpk_units = **2,742**

⚠️ Note vs delivery table (Groc/Cons 7,782 + GM 1,400 = 9,182 non-bkpk cases ✓ —
matches!). The delivery "Bkpk boxes 217" is *boxes*; psn `bkpk_units` 2,742 is
*inner packs inside* those boxes. Different units, both real. Good.

## 2. Shipment-type allow-list (for aisle calc)
`["RDC","HVDC","MP","MPDD","F","FDD","MK","MILK","CANDY"]`
→ "Internalized Parcel" is **excluded**. (Matches our capture: that load has 0
details anyway.)

## 3. Aisle location map — `AisleLocation.ashx`
`func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=<n>`, `credentials:include`.
Response keys: `refreshed_from_bq, aisles, locations`
- `aisles`: 57 entries, shape `{ zone, aisle }` e.g. `{zone:"A", aisle:1}`
- `locations`: 12,693 entries, shape `{ dept_nbr, upc_nbr, zone, aisle }`
  e.g. `{dept_nbr:92, upc_nbr:78099320668, zone:"A", aisle:8}`
- `upc_nbr` is a **number** here; `gtin_nbr` in psn is a **string** → must
  `parseInt` to join (CV does exactly this in `_hasAisleLocation`).
- Aisle label displayed = `zone + aisle` (e.g. "A8").
- Only depts **92 + 95** (`gv_locDeptNbrs`).

## 4. CPH rates — use the STATIC config table
`main_json.cph` present: **FALSE** (0 depts) for this store/day.
→ So CV falls back to `config_deptListing` (the 66-dept static table). Our
two-tier lookup should still *check* `main_json.cph` first (future-proof) but for
1458 today it uses the static values. This means: hardcode `config_deptListing`,
optionally read `fpt_mainJson.cph` when non-empty.

## 5. Hours formula (CONFIRMED from calc.js + casesByAisle.html)
```
cph        = main_json.cph[dept] ?? config_deptListing[dept] ?? 65
if dept in [21] (vendor-set) → hours = 0
hours(dept) = (full_cases + bkpk_units) / cph      // NO rounding — exact HH:MM
```
Aisle footer uses the same `(full_cases + bkpk_units) / config_getCPH(dept)`.

## 6. Per-dept rollup (this capture) — for regression testing
Full list in `tools/captured/summary.txt`. Spot checks:
- D92 (Dry Grocery, cph 47): 1,436 cases / 53 bkpk
- D95 (DSD Grocery, cph 47): 1,251 cases / 0 bkpk
- D90 (Dairy, cph 48): 711 / 0
- D91 (Frozen, cph 50): 688 / 0
- D29 (Intimates, cph 60): 0 / 488
These become golden-master assertions for the rewritten compute.js.

## 6. Plan-date filtering (psn_checkIncludeInPlanOrNot) - CRITICAL

CV filters loads per plan date. Ported from psn.js line 677.
Inputs come from fpt_mainJson:
- api_for_shipments_source ('sfd'/'sds')
- shipments_moved[] -, unload_date} (manual moves win)
- shipments.data.trailers.payload[] - stops[0]:
    transLoadId, loadStatus, inductWindowEndTs (deliver-by),
    stopLocationTimeZone, actualShipments[0].caseQuantity/pckQty

Rule: moved trailer must have unload_date == planDate (else excluded).
Otherwise deliver-by date (store-local tz) must == planDate.
Tender Canceled always excluded. Internalized-parcel/ODOT excluded via
caseQty/pckQty null checks.

Verified: our 7 psn loads all deliver-by 2026-07-28 local (EDT) so kept
today, all dropped for a 2026-07-29 plan. See lib/compute.js shouldIncludeLoad.
