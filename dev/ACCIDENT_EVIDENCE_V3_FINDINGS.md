# Accident Charge Summary — probe v3 (2026-06-02 PM)

Probe script: `dev/probe-accident-evidence-v3.mjs`. Capture:
`dev/accident-v3-probe.json`. Screenshots:
`dev/accident-v3-1-loaded.png`, `dev/accident-v3-2-after-submit.png`.

## Status: ✅ ENDPOINT IDENTIFIED — ready to implement

## The endpoint

```
GET https://storage.googleapis.com/cas_storage/cas_static_html/<storeNbr>.html
```

Examples:
- Store 1458 → `https://storage.googleapis.com/cas_storage/cas_static_html/1458.html`
- Store 670  → `https://storage.googleapis.com/cas_storage/cas_static_html/670.html` (untested)

Returns `text/html` (~30KB for an active store), status 200. The
accident-charge-summary.html form on one.walmart.com is just a launcher
— after the user enters a store number and clicks Go, the page redirects/
loads the corresponding static HTML from this Cloud Storage bucket.

## Auth

- The cas_storage bucket appears to serve these files without auth
  (no Authorization header, no required cookies — Google Cloud Storage
  public-ish object).
- `https://storage.googleapis.com/cas_storage/*` is **already in
  manifest.json host_permissions** (added earlier for an unrelated
  reason). No manifest change needed.

## HTML structure

Two sibling tables, both with the same 11-column schema:

1. **Bodily Injury Evidence Report**
2. **Garage Keeper - Property Damage Evidence Report**

(Plus an "FY27 PNL Summary" table further down — different schema; skip.)

Each table is wrapped in:
```html
<h2><center>{section title}</center></h2>
...
<table class=dataframe>
  <tbody>
    <tr class="firstline">
      <th>Reference Nbr</th>
      <th>Claimant</th>
      <th>Tracking #</th>
      <th>Days since claim Open</th>
      <th>Customer Statement</th>
      <th>Witness Statement</th>
      <th>Video</th>
      <th>Photos</th>
      <th>Evidence Collection Sheet</th>
      <th>Evidence Status</th>
      <th>Enhanced Export?</th>
    </tr>
    <tr>
      <td class=cellinside>26146415</td>
      <td class=cellinside>LEEPER, S</td>
      <td class=cellinside><a href="...fedex...">871840384711</a></td>
      <td class=cellinside>15</td>
      <td class=cellinside>Yes</td>
      <td class=cellinside>Yes</td>
      <td class=cellinside>Yes</td>
      <td class=cellinside>Yes</td>
      <td class=cellinside>No - Report was not received</td>
      <td class=cellinside>Inefficient</td>
      <td class=cellinside>Yes</td>
    </tr>
    ...
  </tbody>
</table>
```

## Live values captured (store 1458, 2026-06-02 PM)

The HTML embeds a header `All information below updated on: 2026-06-02`
— that's the data freshness timestamp.

| Report | Ref # | Claimant | Days open | Missing | Status |
|---|---|---|---|---|---|
| Bodily Injury | 26146415 | LEEPER, S | 15 | Evidence Collection Sheet | **Inefficient** |
| Garage Keeper | 26164705 | MARTIN, G | 2 | Customer Statement, Video, Evidence Collection Sheet | **Inefficient** |

Both rows graded "Inefficient" — these are exactly the type of records
the dashboard needs to surface.

## Cell value vocabulary observed

| Field | Values |
|---|---|
| Customer/Witness Statement, Evidence Collection Sheet | `Yes`, `No - Report was not received` |
| Video | `Yes`, `No - Video was not received` |
| Photos | `Yes`, `No - Photos were not received` (inferred) |
| Evidence Status | `Efficient`, `Inefficient` (inferred — only "Inefficient" seen in this sample) |
| Enhanced Export? | `Yes`, `No` |

Mapping to the `EvidenceStatus` enum in DATA_CONTRACTS:
- `Yes` → `complete`
- `No - ...` → `missing`
- empty / `—` → `unknown`

`Tracking #` cell may contain a FedEx tracking link wrapped in `<a>`.
Strip the anchor; keep the number.

## Refresh cadence

Data is regenerated daily (the embedded "updated on" timestamp). 30-min
poll is overkill; 4–6h matches the data's actual update cycle. Use 4h
to keep the freshness budget reasonable.

## Open questions resolved

- ✅ **C-Q1 (data endpoint):** `cas_storage/cas_static_html/<storeNbr>.html`
- ✅ **C-Q2 (POST or GET):** GET with store in the URL path. No form needed.
- ✅ **C-Q3 (status vocabulary):** Yes / `No - {reason}` / `Efficient` / `Inefficient`
- ⚠️  **C-Q4 (raw open date):** Not in this HTML. Only `Days since claim Open` is exposed. We'll keep that as `daysOpen` and not derive a raw date.
- ✅ **C-Q5 (pagination):** No pagination — single static HTML, all rows embedded.

## Integration plan

1. `lib/sources/accident.js` with `fetchAccident(storeNbr)` + lightweight HTML parser (no DOMParser in SW — regex-based extraction).
2. `pull_accident` SW handler.
3. Alarm at 4h interval.
4. Bootstrap on dashboard open.
5. Widget unblock + drill-down with two sections (Bodily Injury + Garage Keeper).

Sensitive data note: claimant names are PII. Apply the same operator-name
guidance from SECURITY_NOTES — display as-is in the drill but never
bulk-export without confirmation.
