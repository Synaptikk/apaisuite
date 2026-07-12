# Implementation Plan

How to turn this discovery into an APAISuite module called **`livedashboard`**.
This document is the recipe a future implementation session executes
against — it assumes the rest of the docs in this folder are read first.

**Last reviewed:** 2026-06-02.

---

## 1. Surface decision: separate module vs. shell header widget

Per the brief, the dashboard "should appear as a live dashboard on the
APAISuite home/header area" — not a buried tool.

**Two viable shapes:**

**(a) Standalone module with `kind: "fullpage"`.**
Add a `livedashboard` sidebar entry; it becomes the route the shell opens
to by default if the user has no other route in the hash. Pros: zero shell
changes; follows MODULE_CONTRACT exactly. Cons: not visible from other
module pages.

**(b) Header strip + fullpage drill-down.**
A compact 5-widget strip that's mounted on the shell header always (i.e.,
the shell renders it above the routed module's container), with click-to-
drill-down into a fullpage `livedashboard` route. Pros: always visible.
Cons: requires a shell-level extension point that doesn't exist today
(`app.js` does not have header slots).

**Recommendation: (a) for V1, plan (b) as V2.** The header-slot work is
a platform change that warrants its own design pass and would otherwise
balloon V1. V1 ships as a standalone module + the shell default-route is
set to `livedashboard` so it's what users see when they click the
toolbar icon. V2 (after the widget content has stabilized) adds the header
strip via a single, deliberate extension point in `app.js`.

---

## 2. Module skeleton

Per [MODULE_CONTRACT.md](../MODULE_CONTRACT.md), drop:

```
modules/livedashboard/
  module.js
  service.js
  view.js
  view.html
  styles.css
  data/
    risk_rules.json     ← user-tunable thresholds
    source_registry.json
  lib/
    sources/
      absences.js       ← thin wrapper over closinglist message contract
      compliance.js     ← Enviance backend probe (post-discovery)
      accident.js       ← one.walmart.com fetch + table parser
      cvp.js            ← Hoops GraphQL — per-store variant
      register.js       ← Power BI capture + XLSX import + matching
    polling.js          ← alarm wiring, per-source pull lifecycle
    freshness.js        ← lastSuccess/lastAttempt/lastError storage
    matchers.js         ← R1–R6 register matching algorithm
    schemas.js          ← runtime validators (Zod-style or hand-rolled)
  components/
    Widget.js           ← single-widget render w/ state, last-refresh, drill
    WidgetGrid.js
    DrillCallouts.js
    DrillCompliance.js
    DrillEvidence.js
    DrillCvp.js
    DrillRegister.js
```

Add to `modules/_registry.js`:
```js
import livedashboard from "./livedashboard/module.js";
export default [livedashboard, /* existing */];
```

Optional shell-default: in `app.js`, if `location.hash === ""` and
`livedashboard` is in the registry, navigate to `#/livedashboard`. This is
the only allowed shell touch for V1.

---

## 3. `manifest.json` edits

Per [SOURCE_MAP.md](SOURCE_MAP.md):

- **Add host_permission** `https://go.enviance.com/*`.
- Reuse all other existing host_permissions.
- Reuse all existing content scripts — extend
  `modules/digitallocks/content/capture.js` in-place to register a second
  query-signature matcher for the register grid (cleaner than declaring a
  second content script on the same host).

The brief explicitly authorizes adding a content script on
`https://go.enviance.com/*` only if the SPA does not expose a capturable
backend API. **Don't add it preemptively** — let the probe decide.

---

## 4. SW handlers

Defined in `modules/livedashboard/service.js`. Standard suite pattern:
`async (msg, sender) => result`, namespaced storage keys, no `host` in SW.

| Handler type | Purpose |
|---|---|
| `pull_absences` | Trigger or read cached `closinglist`-scraped absences for current store |
| `pull_compliance` | Fetch Enviance task list for current facility |
| `pull_accident` | Fetch accident-evidence summary tables for current store |
| `pull_cvp` | Hoops GraphQL per-store CVP query for current Walmart week |
| `pull_register_import` | Accept XLSX bytes (base64) and parse into discrepancies |
| `pull_register_auto` | (V1.5) Drive Power BI, capture XLSX, parse |
| `refresh_all` | Fan-out all `pull_*` handlers in parallel, ignore cache |
| `analyze_register` | Re-run matching algorithm over current discrepancies |
| `dismiss_finding` | Mark a `RegisterFinding` as dismissed |
| `get_dashboard_state` | Single read of all freshness + rollups (used by view on mount) |

Plus broadcast types FROM the SW:
- `source_progress` — sub-step progress for a pull (e.g. "IVR menu loaded")
- `source_complete` — pull done, with `{ sourceId, ok, error, rolledUpCounts }`
- `findings_updated` — register analyzer reran, new findings available

---

## 5. Per-source pull lifecycle

```
alarm fires
  ↓
service.pull_<source>
  ↓
1. write freshness.lastAttempt = now
2. call lib/sources/<source>.js::fetch(currentStore)
3. on success:
     - validate against schemas.js
     - persist to IndexedDB (or chrome.storage.local for small payloads)
     - if source is register: run matchers.js → write findings
     - write freshness.lastSuccess, freshness.lastError = null
     - broadcast source_complete { ok: true }
4. on failure:
     - write freshness.lastError = redact(e.message)
     - broadcast source_complete { ok: false, error }
     - DO NOT throw — other sources must keep firing
```

`lib/freshness.js` is the single owner of freshness state. Don't have
view code write freshness keys.

---

## 6. View / UI sketch (no full build in this session)

```
┌──────────────────────────────────────────────────────────────────┐
│ Live Dashboard         Store: [1458 ▼]  [Refresh Now]  [Settings] │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐ │
│ │ Callouts│ │Compliance│ │ Evidence│ │   CVP   │ │  Register   │ │
│ │  Today  │ │ Due Soon │ │   Gaps  │ │Snapshot │ │ Exceptions  │ │
│ │   ─     │ │    ─     │ │    ─    │ │    ─    │ │     ─       │ │
│ │   12    │ │   3 OD   │ │    7    │ │  17.8%  │ │   4 R1      │ │
│ │ 2 tardy │ │ 8 ≤7d   │ │  2 high │ │ ▲ trend │ │ 11 R2 (hid) │ │
│ │ ●●●●○   │ │ ●●○○○   │ │  ●●●○○  │ │  ●●●●○  │ │   ●●●○○     │ │
│ │ updated │ │ updated  │ │ updated │ │ updated │ │  imported   │ │
│ │ 09:42   │ │ 06:00    │ │ 09:30   │ │ 09:45   │ │  ystrdy 4pm │ │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────────┘ │
│                                                                  │
│  Click any widget for drill-down. Stale widgets show yellow.    │
└──────────────────────────────────────────────────────────────────┘
```

- 5 widgets, equal width.
- Each shows: title, primary count, secondary metric, severity bar (●●●●○),
  last-updated.
- Click = drill-down view (full-page sub-route or modal).
- Widget background tint reflects worst-case rule severity for its source.
- Stale state: yellow border + tooltip with error.
- Settings drawer: store number, per-source intervals, "show only
  exceptions" toggle, dismissed-findings management.

---

## 7. Storage layout

Per [DATA_CONTRACTS.md](DATA_CONTRACTS.md), suite-wide pattern: namespaced
under `livedashboard.*`.

| Key | Backing | Contents |
|---|---|---|
| `chrome.storage.sync["livedashboard.settings"]` | sync | User settings |
| `chrome.storage.local["livedashboard.freshness.<sourceId>"]` | local | Per-source freshness |
| `chrome.storage.local["livedashboard.absences.cache"]` | local | Latest absences (small) |
| `chrome.storage.local["livedashboard.compliance.cache"]` | local | Latest compliance tasks |
| `chrome.storage.local["livedashboard.accident.cache"]` | local | Latest accident records |
| `chrome.storage.local["livedashboard.cvp.cache"]` | local | Current week CVP |
| `chrome.storage.local["livedashboard.cvpHistory.<storeNbr>"]` | local | Trailing weeks |
| IndexedDB `livedashboard.registerDiscrepancies` | IDB | Raw register rows (can grow) |
| IndexedDB `livedashboard.registerFindings` | IDB | Computed findings |

IndexedDB usage follows `digitallocks/lib/db.js` and
`claimsdisposition/lib/db.js` pattern. `unlimitedStorage` permission is
already in manifest.

---

## 8. Coupling with existing modules

### Required couplings

| To | What | Why |
|---|---|---|
| `closinglist` | Send `ivr-progress-now` / receive `ivr-absences-collected` | Reuse existing IVR scraper for Source A |
| `digitallocks` | Co-ownership of `content/capture.js` query matchers | Reuse Power BI capture pattern for Source E |

### How to handle the IVR coupling cleanly

V1: just message-cross with `module: "closinglist"`. Document it.

V2 candidates (defer):
- **Promote scraper to `shared/sources/ivr.js`.** Closinglist and
  livedashboard both import from there. Best long-term but biggest churn.
- **Move IVR scrape to a third module `_sources` that owns all
  cross-module data sources.** Most architectural; least urgent.

### How to handle the Power BI capture coupling

Add a **registry pattern** to `digitallocks/content/capture.js`: instead
of a single `findDataGridQuery` function, expose
`findQueryBySignature(signatureFn)` and let callers register multiple
signatures at load time. The digitallocks module registers its "Lock Name
+ store" signature; the livedashboard module registers its "Register +
date" signature. Both share the ring buffer and the fetch/XHR monkey-patch.

This is small (~20 LoC) and avoids duplicating the patch. Make the change
when implementing Source E; not a prereq.

---

## 9. Implementation phasing

### Phase 1 — Skeleton + 2 cheap sources (≈ 1 day)
- Module skeleton, sidebar entry, empty grid layout
- `pull_cvp` (Hoops, mostly proven)
- `pull_absences` (subscribe to closinglist)
- Freshness wiring + Refresh Now button

### Phase 2 — Probes-required sources (≈ 2 days, gated on probe sessions)
- Run probes for Sources B and C
- Implement `pull_compliance` once Enviance endpoint is known
- Implement `pull_accident` once one.walmart.com response shape is known

### Phase 3 — Register V1 (≈ 2 days)
- XLSX import drop-zone
- Parser → `RegisterDiscrepancy` rows
- R1–R4 matching
- Register findings drill-down

### Phase 4 — Polishing (≈ 1 day)
- Per-source error states, stale indicators
- Store selector
- Settings drawer
- Dismissed findings persistence

### Phase 5 — Register V1.5 (later)
- Power BI automated capture (extension of digitallocks/content/capture.js)
- Operator detail drill-through
- R5–R6 rules

### Phase 6 — Header strip (V2)
- Shell extension point
- Compact header widget grid
- Click → fullpage drill

---

## 10. Outstanding implementation blockers

These MUST be resolved before the corresponding code can land.

| Blocker | Blocks | Resolution path |
|---|---|---|
| Hoops cross-origin cookie behavior | `pull_cvp` clean implementation | Run the bg-fetch test in [ENDPOINTS.md §Source D](ENDPOINTS.md) — if cookies don't carry, switch to tab-script pattern |
| Enviance endpoint shape | `pull_compliance` | Probe per [ENDPOINTS.md §Source B](ENDPOINTS.md) |
| Accident-evidence response shape | `pull_accident` | Probe per [ENDPOINTS.md §Source C](ENDPOINTS.md) |
| Register Power BI query signature | `pull_register_auto` (V1.5) | Capture live, identify property names. NOT a V1 blocker since V1 is XLSX import. |
| Walmart fiscal-week computation | `pull_cvp` | Existing open question carried over from `dev/HOOPS_FINDINGS.md`. Need a `wmWeek(date)` helper. |

---

## 11. Risks & non-goals

**Non-goals for V1:**
- Multi-store comparisons. The dashboard is single-store (current store
  selected in settings).
- Historical analytics beyond 30 days for register, 8 weeks for CVP.
- Push/desktop notifications. The dashboard is pull-only.
- Cross-source compound signals (e.g. "high callouts + register
  exceptions on same day"). Defer to V2.

**Risks:**
- **Coupling closinglist↔livedashboard creates ordering sensitivity.** If
  the user disables the closinglist module, absences silently break.
  Mitigation: livedashboard.absences source checks for
  `closinglist` in `registry.listModules()` at startup and surfaces a
  configuration error if missing.
- **Power BI session expiration is invisible.** A failed Power BI capture
  may return blank results without an error. Mitigation: detect
  "0 captures in N seconds after navigation" and surface as a specific
  error ("Power BI session expired — open the report manually to re-auth").
- **Enviance and one.walmart.com auth posture is unknown.** Probe-first;
  don't assume cookies-included works until verified.
