# DigitalLocks — Power BI pull findings

> **Status: implemented 2026-08-29.** The method described below ships in
> `modules/digitallocks/lib/powerBiQuery.js`, wired into
> `service.js::runSearchPipeline`. 24 unit tests in
> `lib/tests/power_bi_query.test.mjs`; the builder's verbatim output was
> re-verified against live Power BI after implementation (5,338 rows / 11 zones
> for 1458, 4,826 / 8 for 5260, a correct 688-row date window, and `IC: false`
> correctly detected at a deliberately small window).

**Probed live 2026-08-29** against the real report in the debug Edge profile
(`dev/launch-edge-debug.sh`, Playwright over CDP 9222), report
`New Digital Lock Events` / `a118e7e7-9431-4240-b630-04575d36cc37`.

Everything below is measured, not inferred. Where a number appears it came back
from the live endpoint.

---

## The symptom

"The zone filter only shows Cosmetics."

## The cause

`service.js::runSearchPipeline` replays the data-grid query the *report itself*
last fired, and patches exactly one thing:

```js
const cond = where[0]?.Condition?.In;
cond.Values[0][0].Literal.Value = `'${storeNumber}'`;
```

The captured `Where` array had **three** conditions, because the report persists
per-user slicer state:

| # | Property | Value |
|---|---|---|
| 0 | `Column` (store) | `'1458'` ← the only one patched |
| 1 | `Lock Name` | `'G7-2'` |
| 2 | `Zone Name` | `'46-COSMETICS & SKINCARE-TIER 1'` |

Conditions 1 and 2 were replayed verbatim on every pull, for every store.

### Measured impact

Same endpoint, same auth, same moment, store 1458:

| Query | Rows | Zones | Locks |
|---|---|---|---|
| Verbatim replay (**shipped behaviour**) | **191** | **1** | **1** |
| `Where` = store only, 500-row window | 500 | 11 | 80 |
| `Where` = store only, 30 000-row window | **5 338** | **11** | **98** |

The shipped pull was returning **191 of 5 338 events — 3.6%** — and the UI had
no way to know. The Zone dropdown was reporting the loaded dataset accurately.

## The second bug, found while measuring the first

`Binding.DataReduction.Primary.Window.Count` in the captured body is **500**.
That is the grid visual's own paging window, and it is replayed too. So even
with the slicers cleared, any store with more than 500 events in the retention
window was silently truncated.

This also re-explains a line in `docs/DIGITAL_LOCKS_MODULE.md` — *"Store 1458's
500-row export is entirely one zone"*. That was never the store's real volume;
it was this cap. The risk calibration described in that doc was tuned on a
191–500 row slice of a 5 338 row store, and is worth re-checking against a full
pull.

**Power BI signals the truncation and we were ignoring it:** `DS[0].IC` is
`IsComplete`.

| Window | Rows returned | `IC` |
|---|---|---|
| 1 000 | 1 000 | **`false`** |
| 30 000 | 5 338 | `true` |

## Hard ceiling

Asking for more than 30 000 is not an error — it returns a warning and clamps:

```
Code:     SpecifiedLimitExceedsMaxIntersections
Severity: Warning
Message:  Specified limit (1000000) exceeds maximum allowed number of
          intersections.  The limit will be reduced to its allowed maximum
          of '30000'.
```

So **30 000 rows is the per-query ceiling**. Store 1458 (5 338) and store 5260
(4 826) both fit over the ~60-day retention the dataset holds, but that is
headroom, not a guarantee. `IC === false` is the signal that a store has
outgrown one query.

---

## The better method

**Stop replaying the captured query. Build the query; capture only the transport.**

The capture is still needed — but only for three things, none of which are the
query itself:

| From the capture | Why |
|---|---|
| `url` | tenant-specific `pbidedicated.windows.net` QES host |
| `Authorization` (`MWCToken …`) | self-contained bearer auth, no cookies needed |
| `modelId` (`3120907`) | identifies the semantic model |

Everything else is constructed. Verified working end to end, built from scratch
with no captured body involved:

```js
const src = { SourceRef: { Source: "q" } };
const col = (p) => ({ Column: { Expression: src, Property: p } });

// All nine columns. See "do not trim the Select" below.
const SELECT = [
  ["Lock Name", "Query1.lock_name"],   ["store", "Query1.store"],
  ["Unlock Source", "Query1.unlock_source"], ["USER ID", "Query1.user_id"],
  ["Zone Name", "Query1.zone_name"],   ["datetime_local", "Query1.datetime_local"],
  ["Position", "Query1.Position"],     ["FIRST NAME", "Query1.FIRST NAME"],
  ["LAST NAME", "Query1.LAST NAME"],
];

function buildQuery(store, modelId, { from, to } = {}) {
  const where = [{ Condition: { In: {
    Expressions: [col("store")],
    Values: [[{ Literal: { Value: `'${store}'` } }]],
  } } }];

  // Optional date bound. datetime_local is TEXT — see below.
  if (from && to) {
    const cmp = (kind, v) => ({ Comparison: {
      ComparisonKind: kind, Left: col("datetime_local"),
      Right: { Literal: { Value: `'${v}'` } },
    } });
    where.push({ Condition: { And: { Left: cmp(2, from), Right: cmp(3, to) } } });
  }

  return {
    version: "1.0.0",
    queries: [{
      Query: { Commands: [{ SemanticQueryDataShapeCommand: {
        Query: {
          Version: 2,
          From: [{ Name: "q", Entity: "Query1", Type: 0 }],
          Select: SELECT.map(([p, n]) => ({ ...col(p), Name: n })),
          Where: where,
        },
        Binding: {
          Primary: { Groupings: [{ Projections: SELECT.map((_, i) => i), Subtotal: 1 }] },
          DataReduction: { DataVolume: 3, Primary: { Window: { Count: 30000 } } },
          Version: 1,
        },
        ExecutionMetricsKind: 1,
      } }] },
      QueryId: "",
    }],
    cancelQueries: [], modelId,
    userPreferredLocale: "en-US", allowLongRunningQueries: true,
  };
}
```

Measured with this exact builder:

| Call | Rows | Zones | `IC` | Time |
|---|---|---|---|---|
| store 1458, all | 5 338 | 11 | `true` | 687 ms |
| store 1458, 2026-08-22 → 2026-08-29 | 688 | 11 | `true` | 209 ms |
| store 5260, all | 4 826 | 8 | `true` | 277 ms |
| store 9999999 (bogus) | 0 | — | — | 150 ms |

Sub-second for a whole store. The old DOM export flow this replaced took tens of
seconds and the replay-with-inherited-filters took 294 ms to return 3.6% of the data.

### Why this is strictly better than patching the replay

- **No slicer inheritance is possible.** There is nothing to inherit; the
  `Where` array is ours. Whatever the analyst last clicked in Power BI cannot
  reach the pull.
- **No index assumption.** The current code assumes `where[0]` is the store.
  It is today by luck of ordering. If the zone condition ever sorted first, the
  code would overwrite the *zone* filter with a store number and return zero
  rows behind a "this store has no lock events" message.
- **The capture becomes much cheaper to satisfy.** `findDataGridQuery()`
  currently requires a body containing both `"Property":"Lock Name"` and
  `"Property":"store"` — i.e. the grid visual must have rendered. Any QES
  request carries the url, token and modelId, so a slicer query is enough.
- **Arbitrary store, independent of the slicer.** Confirmed: filtering to 5260
  returned 4 826 rows all stamped `store: 5260`, while the report's own slicer
  sat on 1458.

### Verified details that will bite whoever implements it

1. **`IC` must be checked.** `DS[0].IC === false` means truncated. Treat it as
   an error or a trigger to page by date — never return the rows as if complete.
   This is the guard the shipped code never had.

2. **`datetime_local` is TEXT, not a datetime.** A `datetime'...'` literal is
   rejected by the server; a plain `'2026-08-01'` string comparison works. The
   stored format is `YYYY-MM-DD HH:MM:SS.mmm`, so lexicographic ordering is
   chronologically correct and `>= 'YYYY-MM-DD'` / `< 'YYYY-MM-DD'` is a safe
   date window. This is the paging mechanism if a store ever exceeds 30 000.

3. **Do not trim the `Select` to save bandwidth.** DSR groups by the projection
   tuple. Cutting the nine columns to four dropped 5 338 rows to 5 336 — two
   events that differed only in a removed column collapsed into one. The column
   list is load-bearing for row *count*, not just for content.

4. **Filter on `store`, not `Column`.** Both work and return identical results,
   but `Column` is the slicer's own field name and `store` is the one that also
   appears in the `Select` and in `parseLockEvents.js::HEADER_ALIASES`. One
   fewer magic name.

5. **Token lifetime is ~82 minutes.** The `MWCToken` carried `iat 1788033852` /
   `exp 1788038785`. Long enough for a pull, short enough that a stale capture
   is a real failure mode for the daily-refresh alarm — the existing
   `classifyAuthResponse` / reload-and-retry path still earns its place.

6. **Empty results have no `DM0`.** A bogus store returns a well-formed response
   whose `PH[0].DM0` is absent. `lib/dsrDecode.js` already guards this
   (`dm.length === 0` → `[]`); an inline reimplementation during this probe did
   not, and threw. Don't re-derive the decoder.

7. **Decoded column names already match the parser.** The nine keys come back as
   `Lock Name`, `store`, `Unlock Source`, `USER ID`, `Zone Name`,
   `datetime_local`, `Position`, `FIRST NAME`, `LAST NAME` — all nine resolve
   through `HEADER_ALIASES` unchanged. No mapping layer is needed.

### Data shape, for reference

~60 days of retention (2026-06-30 → 2026-08-28 at time of probe). Store 1458:
11 zones, 98 locks, 5 338 events.

---

## Follow-on worth doing

- **Re-check the risk calibration.** `riskScoring.js`'s base-rate suppression
  was tuned against a single-zone 500-row slice; on a real 11-zone pull the
  `HIGH_RISK_ZONE` firing rate — the specific thing the suppression exists to
  handle — is a completely different number.
- **Wire `digitallocks` into `shared/schema_watch.js`.** It is already on the
  list in `CURRENT_TASKS.md` §8 as an unwired source. The DAX result column set
  is exactly the kind of thing that changes silently, and this probe establishes
  the baseline shape.
- **Wrap the pull in `shared/sw_keepalive.js`** — also already flagged in §9.
  Less urgent now that a pull is sub-second rather than tens of seconds.
