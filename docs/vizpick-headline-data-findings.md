# VizPick Backroom Health — Headline Data Source Investigation

**Status:** Read-only recon complete. Data sources identified for all 8 rings.
No workbook content was modified, saved, or published during this investigation.

**Dashboard:**
`https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails`
(optionally scoped with `?Store=<storeNumber>`)

---

## TL;DR (plain English)

- **VizPick Health + the 4 grid percentages (Cases, Locations, Picks, Overstock)**
  all come from ONE exportable worksheet: `VizPick Donut Health`.
- **Fresh, F&C, and GM** come from a SECOND worksheet: `Department Groups Donuts Health`.
  These are NOT computed by mapping department numbers to a group — Tableau already
  has a column literally called `Department Group` with values `Fresh`, `F&C`, `GM`,
  each carrying its own pre-computed score. No guessy department-number mapping needed.
- Both sheets are reachable the same way the two already-known sheets are (Download →
  Crosstab), so the existing extraction pattern extends cleanly.
- **Open item:** we don't yet have the `sheetdocId` GUID for these two sheets, which is
  what would let a script silently request the crosstab (like it does for the two
  known sheets) without a human clicking the Download dialog. The raw multipart probe
  used for the known sheets came back with a validation error (`missing: thumbnail-uris`)
  against this endpoint on this attempt, and repeated probing briefly rate-limited us
  from the host. This needs one clean DevTools session (Network tab open, click Download
  → Crosstab once for real) to capture the exact request body Tableau expects, then GUIDs
  become trivial to extract per sheet — same pattern as `Download Location Details` /
  `Download Department Breakout (Current Day)`.

---

## 1. Worksheets discovered on the VizPick Details dashboard

Confirmed via the real Download-Crosstab dialog UI and Tableau's own JS embedding API
(`window.tableau.VizManager`) — not the raw multipart probe (that leg failed, see below).

```
VizPick Donut Health                                   <- headline VizPick Health + 4 grid metrics
Department Groups Donuts Health                        <- Fresh / F&C / GM
Cases Donut Health
Locations Donut Health
Picks Donut Health
Overstock Donut Health
Download Department Breakout (Current Day)             <- already known {95A7AC48-BC4F-432B-9590-5A424FF72939}
Download Location Details                               <- already known {DE528639-7176-4925-BBC6-CD07ECC646F1}
Download Location Details (2)
Download Department Breakout (Current Day Phone)
Download Locaitons (Clearance Cases)
Download Locaitons (Clearance Cases Phone)
Download Locaitons (Modular Deleted Cases)
Download Locaitons (Modular Deleted Cases Phone)
Metric Definitions Moble
External Cases
Last update
Notification (2)
```

No `sheetdocId` GUIDs were recovered for the new sheets (see "Open item" above).

---

## 2. Sheet contents (verbatim crosstab export, header + data rows)

### `VizPick Donut Health`
```
Cases Seen %	New Location %	New Overstock %	New Pick %	New VizPick 	New VizPick Remaining
			98	2.072630895
93%	98%	91%	87%	98	
```
Column-to-ring mapping:
- `New VizPick ` (note trailing space) → **VizPick Health** ring (98)
- `Cases Seen %` → **Cases** grid value (93%)
- `New Location %` → **Locations** grid value (98%)
- `New Pick %` → **Picks** grid value (87%)
- `New Overstock %` → **Overstock** grid value (91%)

Each row-pair in the export is a background/remaining arc row + an actual-value row
(that's just how Tableau renders a donut chart's two arc segments in a crosstab — not
two different metrics).

### `Department Groups Donuts Health`
```
Department Group	Cases Seen %	New Location %	New Overstock %	New Pick %	New VizPick 	New VizPick Remaining
Fresh							95	4.741211888
Fresh	89%	97%	95%	83%	95	
```
Full 3-group data captured in this export:

| Department Group | Cases Seen % | New Location % | New Overstock % | New Pick % | New VizPick |
|---|---|---|---|---|---|
| Fresh | 89% | 97% | 95% | 83% | 95 |
| F&C   | 96% | 97% | 88% | 91% | 100 |
| GM    | 90% | 99% | 88% | 80% | 94 |

### `Cases Donut Health` / `Locations Donut Health` / `Picks Donut Health` / `Overstock Donut Health`
Not exported — the host connection dropped (`net::ERR_CONNECTION_CLOSED`) after the two
exports above, consistent with a WAF/rate-limit trip from earlier raw-fetch probing in
the same session. **Not required for the goal, though**: the 4 grid values are already
fully present as columns on `VizPick Donut Health` (see mapping above). These 4 sheets
are almost certainly single-metric-filtered slices of the same data, used only to render
each ring individually on the dashboard — not a separate data source. Not independently
confirmed; flagged as a nice-to-have follow-up, not a blocker.

---

## 3. Presentation model / tooltip JSON

Not required — Task 2 (crosstab export) fully surfaced all 8 headline numbers, so no
digging through `bootstrapSession` / `render-tooltip-server` JSON payloads was necessary.

(Incidental note: a real mouse hover over the rings does fire genuine
`.../commands/tabsrv/render-tooltip-server` network calls, confirmed via Performance
Timing API — so tooltip-based extraction is a viable fallback path if the crosstab
approach ever breaks.)

---

## 4. Fresh / F&C / GM — what they actually are

**Column name:** `Department Group` (literal header, on the `Department Groups Donuts
Health` sheet).
**Row values, verbatim:** `Fresh`, `F&C`, `GM` — these are dimension values of that
column, not three separate metric fields.

Each Department Group row carries its own independently-computed `New VizPick ` score
(same field name — trailing space included — as the headline ring on `VizPick Donut
Health`), built from the same four sub-metrics: `Cases Seen %`, `New Location %`,
`New Overstock %`, `New Pick %`.

**Answering the key question directly:** Fresh/F&C/GM are NOT an aggregation you'd
compute by mapping department numbers (from `Download Department Breakout (Current Day)`)
into groups. They are distinct, pre-aggregated rows in a separate worksheet
(`Department Groups Donuts Health`) dimensioned directly by a field literally called
`Department Group`, whose values are the exact strings `Fresh`, `F&C`, `GM`. No
department-number-to-group mapping exists in the export, and none is needed — the
crosstab is already grouped at the right level, with no numeric department column
present at all.

---

## Parser guidance for the extension

1. Pull crosstab CSV for `VizPick Donut Health` → parse `New VizPick ` (mind the
   trailing space) for VizPick Health; parse `Cases Seen %`, `New Location %`,
   `New Pick %`, `New Overstock %` for the 4 grid rings.
2. Pull crosstab CSV for `Department Groups Donuts Health` → filter/group by
   `Department Group` in (`Fresh`, `F&C`, `GM`), read `New VizPick ` per group.
3. Ignore the "background/remaining" arc row in each export (identifiable by blank
   percent columns) — only the row with populated percent columns is the real value row.

## Follow-ups before this is production-ready for headless pulling

- [ ] Capture the correct multipart body for `export-crosstab-server-dialog` (missing
      field beyond `telemetryCommandId`, error was `missing: thumbnail-uris`) to recover
      `sheetdocId` GUIDs for `VizPick Donut Health` and `Department Groups Donuts Health`.
- [ ] Throttle any headless polling — host briefly rate-limited/blocked the session after
      rapid-fire export + probe requests in one sitting.
- [ ] (Nice to have, not blocking) Confirm the 4 individual `X Donut Health` sheets are
      indeed redundant with `VizPick Donut Health`.
