# DigitalLocks Module

Daily AP review tool for digital lock unlock events. V1 lives entirely inside
APAISuite's shell page — no network calls, no service-worker work, no extra
host permissions.

## Purpose

Help AP reviewers prioritize which digital-lock unlock events deserve a closer
look. Every flagged event is a **triage hint, not a verdict**. The module
never labels a user as guilty.

UI copy uses: *high-risk event · needs review · unusual access · outlier ·
mismatch · after-hours activity*. It never uses: *thief · guilty · bad actor
· malicious employee*.

## Data source

Power BI report:
`https://app.powerbi.com/groups/me/reports/a118e7e7-9431-4240-b630-04575d36cc37/217785fb10b56ddae020`

Two ingest paths in V1.5:

**A. Automated (Search by store)** — preferred. Type a store number, click
Search. The SW:
1. Opens (or finds) a background `app.powerbi.com` tab on the report.
2. Injects `content/powerbi_driver.js` via `chrome.scripting.executeScript`.
3. Waits until the data grid + Store slicer are rendered.
4. Drives the slicer to the requested store and waits for the visual to
   re-query.
5. Hovers the data-grid visual, clicks the per-visual More-options button,
   chooses "Export data", picks the Excel (.xlsx) radio in the dialog, and
   clicks Export.
6. Captures the .xlsx via `chrome.downloads.onCreated`, reads the bytes
   back, returns them base64 to the view.
7. The view feeds the bytes through the existing CSV/XLSX parser, scorer,
   IndexedDB persistence, and status overlay — no parallel code path.

**B. Manual import** — fallback. Open the Power BI report yourself,
Export → Excel from the data grid menu, drag-drop into the module's Import
CSV / Excel button. Same parser, same pipeline.

## Import workflow

Supported file types in V1:

- `.csv` — handles UTF-8 BOM, CRLF, quoted fields, escaped quotes (`""`).
- `.xlsx` / `.xlsm` — parsed in-house via a minimal OOXML + ZIP reader
  (`lib/xlsx.js`) using the browser's `DecompressionStream("deflate-raw")`.
  No third-party library is required; APAISuite's `minimum_chrome_version`
  is `120`, well above the 103 floor where `DecompressionStream` shipped.

Header aliases (case- and whitespace-insensitive) are resolved in
`lib/parseLockEvents.js::HEADER_ALIASES`. Required canonical fields:
`store`, `lockName`, `zoneName`, `userId`, `eventTime`. Missing required
columns abort the import with a clear error.

Stable event IDs are derived from `(store, userId, lockName, zoneName,
eventTimeRaw)` via DJB2 — re-importing the same Power BI export merges
deterministically with the prior import's review-status overlay.

## Risk scoring model

All rules are pure functions in `lib/riskScoring.js::scoreEvents`. Each
event accumulates a numeric score; the score maps to a label via the
configurable `bands` table.

| Trigger | Weight |
|---|---|
| After-hours 12 AM – 5 AM (`AFTERHOURS_DEEP`) | +50 |
| Late/early 11 PM – 12 AM or 5 AM – 7 AM (`AFTERHOURS_EDGE`) | +35 |
| …same, but the job code is normally on shift then **and** the event is in that role's own area (`AFTERHOURS_EDGE_EXPECTED`) | +10 |
| …same, but *this associate* demonstrably works these hours (`AFTERHOURS_EDGE_HABITUAL`) | +0 |
| Role / zone mismatch | +25 |
| High-risk zone or lock (keyword hit) | +20 |
| High per-day unlock volume | +15 |
| Multiple zones in short window | +15 |
| Same lock repeated in short window (>= `repeatedLockMinOpens`, default 3) | +10 |
| Unusual unlock source (not the dominant one in the import) | +10 |
| Day/hour spike (store mean + 2σ, **and** unusual for that associate) | +10 |

Bands: **0–24 Normal · 25–49 Watch · 50–74 High · 75+ Critical**.

Each event always carries `riskReasons[]` — a human-readable list of every
rule that fired. **A score without its reasons must never be displayed.**

### Calibration: rules score deviation, not attributes (2026-08-22)

Those weights are the *starting* values. Applying them literally produced a
review queue containing every event in the import, for a reason worth stating
plainly: **a reason that describes every event describes none of them.**

Store 1458's 500-row export is entirely one zone (`72-ELECTRONICS DESK-TIER 2`),
worked by the Entertainment associates whose job that case is. `HIGH_RISK_ZONE`
fired on 100% of rows, adding a flat +20 to everything; one more +10 rule tipped
each row past the Watch band. Meanwhile `HIGH_VOLUME` compared each associate to
a store-wide p95 dominated by people who barely touch locks — so the two people
who work the case most were flagged daily for doing their jobs — and
`DAY_HOUR_SPIKE` flagged noon, the busiest hour of the day.

`risk_weights.json::calibration` (fully commented, `enabled: false` restores the
old behaviour exactly) changes four things:

- **Base-rate suppression.** A rule's weight scales toward zero as the share of
  events it fires on rises past `suppressAbove`. Rules named in
  `pinnedRules.rules` are exempt — `AFTERHOURS_DEEP` is pinned by default,
  because a store where 3am openings are routine is a finding, not a new normal.
- **Per-associate volume.** Compared to that user's own median day, not the
  store's p95.
- **Per-associate hours.** An edge-hours or hour-spike event inside the user's
  own learned shift envelope stops scoring. Users below
  `userBaseline.minDaysForBaseline` / `minEventsForBaseline` get no envelope, so
  a single 3am event can never establish 3am as somebody's pattern.
- **Observed role/zone pairings.** A (position → zone) pairing seen
  `minEvents` times from `minUsers` *distinct* people is how the store runs, not
  an exception. Requiring several people is what keeps one person repeatedly
  going somewhere they shouldn't from normalising itself.

Suppressed reasons are not discarded — they move to `baselineReasons[]` and
render as muted dashed chips, so a row still reads truthfully without implying
the event is unusual. `_meta.fireRate` / `_meta.weightScale` expose what the
calibration decided. Pinned by `lib/tests/risk_calibration.test.mjs`.

## Configurable rule files

All three live in `modules/digitallocks/data/` and are user-editable
without code changes:

- `role_zone_rules.json` — position → allowed-zone-keywords map, plus
  `broadAccessPositions` (AP, TLs, Coaches, Store Managers, service
  technician, install) exempt from the mismatch rule, plus
  `expectedEdgeHourPositions` (job codes normally on shift across the
  11 PM / 5–7 AM shift-change edges — overnight, CAP1/CAP3, maintenance,
  receiving, bakery/deli/produce/meat, OGP, fuel, front-end openers).
  All lists are plain substring matches against `Position`.

  **Stocking / overnight / maintenance were removed from
  `broadAccessPositions` on 2026-08-20** and given explicit `roleZoneMap`
  entries. Every zone this report emits is a locked high-value case, so
  "broad access" meant an overnight stocker could open the pharmacy or
  jewelry case at any hour and never be flagged. Their maps allow the
  TIER 1 general-merchandise zones and exclude TIER 2, Pharmacy and New
  Devices; the keywords are anchored (`electronics-tier 1`, not
  `electronics`) so the TIER 2 desk does not match, which means they need
  revisiting if the Power BI zone naming changes.

  The two interact: the edge-hours discount fires only when the position is
  on `expectedEdgeHourPositions` **and** `roleZoneMap` positively allows the
  zone. A position missing from `roleZoneMap` returns "cannot judge", which
  both suppresses the mismatch rule and blocks the discount — so a job code
  added to `expectedEdgeHourPositions` needs a `roleZoneMap` entry as well,
  or it will silently never be discounted.
- `high_risk_keywords.json` — substrings matched against zone+lock name.
- `risk_weights.json` — weights, bands, time-window definitions, and
  outlier thresholds.

The view re-fetches and re-scores on every mount, so an edit + reload of
the shell is enough to see the change. No migration step.

## Storage behavior

Per the audit decision on 2026-06-01:

- **IndexedDB** (`apaisuite-digitallocks.imports`) holds immutable per-import
  blobs (events + summary). One record per file import. Pattern matches
  `claimsdisposition/lib/db.js`.
- **`host.storage.local`** (`digitallocks.status.<eventId>`) holds the
  mutable review-status overlay. A status edit rewrites one ~150-byte key
  rather than the entire import.
- **`host.storage.local`** (`digitallocks.activeImportId`) tracks which
  import is currently surfaced in the dashboard.

Status overlay survives:
- Re-imports of the same file (event IDs are deterministic).
- Switching between saved imports.
- Deleting an import (overlay remains keyed to the eventId; if the same
  event is re-imported later, the prior disposition is restored).

## Review statuses

| Status | Label | Meaning |
|---|---|---|
| `active` | Active | Fresh; awaiting review |
| `needs_follow_up` | Needs follow-up | Reviewer wants more info before deciding |
| `confirmed_theft_review` | Theft Review | Escalated for theft-review process |
| `non_malicious` | Non-Malicious | Reviewer has explained the event |
| `dismissed` | Dismissed | Reviewer chose to ignore (known operational pattern) |

`confirmed_theft_review` is the formal escalation channel — it does **not**
imply theft occurred. The label names the downstream review process.

## New-import disposition

When importing while an active queue exists, a modal asks the reviewer:

- **Replace active list** — the new import becomes the active queue; old
  active events stay in IndexedDB and the overlay (visible under Imports).
- **Append to existing** — merges by event ID; status overlay preserved for
  any rows present in both imports.
- **Archive old, start new** — every prior `active` event is marked
  `dismissed` with `clearedReason: "archived"`, then the new import takes
  over.
- **Cancel** — no change.

We never silently wipe.

## Daily checklist (Episode view)

Per-row repetition (same user, same zone, six unlocks in 10 minutes) is
collapsed into one **episode** so the morning checklist isn't bloated with
duplicates. Episodes group `(userId, zoneName)` runs whose gap is ≤
`thresholds.multiZoneWindowMinutes` (30 min by default). The full event
table still shows every row.

## Open questions

See `docs/DIGITAL_LOCKS_QUESTIONS.md`. None of them block V1.

## Future automation options

1. Persistent dashboards/exports of historical risk patterns over time.
2. Per-store baselines (per-user-per-zone) for the volume rule, kept in
   IndexedDB alongside imports.
3. Background fetch of the Power BI export via a same-origin scripted call
   inside a hidden `app.powerbi.com` tab (mirrors the Looker pattern in
   `claimsdisposition`). Requires `app.powerbi.com/*` in
   `host_permissions` and a `digitallocks/content/` script — not done in V1.
4. PDF export of the daily checklist using the vendored `pdfmake` already
   shipped with `claimsdisposition` (moving `pdfmake` to `shared/vendor/`
   on first cross-module need is the right call).
