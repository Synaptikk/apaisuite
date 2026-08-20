# StockingPlan — Dev Notes

## What this module does
Builds an overnight stocking plan from CaseVisibility:
- **Schedule** via `Main.ashx?func=init` (content script) → associates by role.
- **Freight** via `sessionStorage.fpt_psnAPIJson` (per-load, per-item detail),
  decompressed with the page's own LZString → rolled up per-dept and per-aisle
  using CV's real rates (see `lib/cvRates.js`).

## Rates & algorithm (source of truth)
All ported from CaseVisibility's own public JS and verified against a live
capture. See `tools/FINDINGS.md`. Hours = `(full_cases + bkpk_units) / dept_CPH`,
exact HH:MM, vendor-set depts (Books/21) = 0.

## Dev tools (`tools/`, not shipped)
- `capture-cv-data.js <store> [date]` — Playwright: signs in, searches, dumps the
  decompressed psn/main JSON + aisle map to `tools/captured/` (gitignored).
- `verify-compute.js` — runs the compute against captured data and asserts the
  known-good totals. **Run this after any change to compute/rates.**
- `explore-cv-tables.js`, `test-cv-fields.js` — older exploration scripts.

## Test
```
node tools/verify-compute.js
```
Requires a prior `node tools/capture-cv-data.js` run to populate `tools/captured/`.
