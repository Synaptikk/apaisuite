# Source schema watch

**What it is:** every source this suite scrapes is an internal dashboard some
other team republishes whenever they like. None of them is an API with a
contract. This watches their *shape* and reports a change the first time it is
seen — ideally before it breaks anything.

**Why it exists:** on 2026-08-22 Tableau renamed two VizPick columns
(`Suggested Picks` → `Suggested Picks Seen`, `Suggested Picks Completed` →
`Suggested Picks Done`). Every current-day capture failed from that moment. It
took two days to notice, because a failed capture correctly leaves the previous
snapshot in place — so the UI kept showing plausible numbers frozen at the last
good pull, and nothing was watching for the source changing under us.

---

## How it works

| Piece | Role |
|---|---|
| `shared/data/source_schemas.json` | The **approved** column list per source. A baseline in git, not a cache. |
| `shared/schema_watch.js` | Pure diff + dedupe. No fetch, no storage, no logging — which is why its tests can assert the exact payload that leaves the machine. |
| `shared/schema_watch_report.js` | Loads the baseline, records drift, mirrors to telemetry, uploads. |
| Firestore `suite_schema_drift` | One document per `sourceId__fingerprint`. |

Three deliberate properties:

- **Observational.** It never fails a parse. A drifted source may still parse
  perfectly — an added column, or a rename we alias — and *that is the case
  worth catching*, because it is the warning before the change that does break
  something. `stillParsed` on each row tells the two apart.
- **Order-insensitive.** Every parser here resolves columns by name, so a
  reorder cannot break anything and reporting it would be noise.
- **Reported once per (source, shape).** A ten-store crawl parses ten times
  every half hour. Without dedupe the signal buries itself.

Doc id is `sourceId__fingerprint`, so the same drift seen on five analysts'
machines converges on **one** document. What matters is that a source changed,
not how many people saw it.

### Privacy

Column **names** only, never row values — names are schema
(`"Suggested Picks Done"`), not data about a store or a person. Unlike
`suite_usage_events` these rows carry no install id, store, market or role, so
they need no pseudonymity argument at all. A test asserts the full key set of
the uploaded payload and checks for known value-shaped strings, so this is not
left to care.

---

## Responding to a drift

You will see it in one of two places: **Settings → tap the heading 10× →
Background activity** (immediate, local), or the Firestore collection (after
the next flush).

A row looks like:

```json
{
  "sourceId": "vizpick.deptBreakout",
  "status": "drift",
  "stillParsed": false,
  "removed": ["Suggested Picks", "Suggested Picks Completed"],
  "added":   ["Suggested Picks Seen", "Suggested Picks Done"],
  "summary": "vizpick.deptBreakout: likely RENAME — gone: …; new: …"
}
```

**1. Read `summary` first.** Equal counts on both sides is flagged
`likely RENAME`, which is the case that silently breaks an exact-name lookup.

**2. Check `stillParsed`.**
- `false` → captures are failing **right now**. The module is showing stale
  data. Fix first.
- `true` → nothing is broken yet. You have time, but the clock is running:
  whatever moved that column will move another.

**3. Fix the parser to accept BOTH spellings.** Not just the new one. Stored
fixtures still have to parse, a reverted workbook must not break us again, and
renaming columns is evidently something these sources do. See
`parseDeptBreakout`'s `colAny()` for the shape.

**4. Verify the numbers, not just that it parses.** A rename that swaps a
numerator and denominator would parse perfectly and render confidently wrong
figures — no error handling catches that. Check a known ratio against the
dashboard (e.g. Pick % = Done / Seen, 54/86 = 63%).

**5. Re-baseline in the SAME commit** as the parser change, so the diff shows
both halves of the decision together.

> Do **not** edit `source_schemas.json` to silence a report. The file is the
> record of a shape someone approved. Editing it first turns the watcher into
> a rubber stamp.

---

## Adding a source

1. Add a key to `shared/data/source_schemas.json` with `description`,
   `approvedOn`, an optional `note`, and the exact `columns`.
2. One line at the parse site — fire-and-forget, and it must never be awaited:

```js
const parsed = parseWhatever(csv.respBody);
watchSourceSchema("mymodule.mySheet", csv.respBody, parsed.ok);
```

`watchSourceSchema` also accepts a ready-made `string[]` of columns, for
sources that are not tab-separated crosstabs (a DAX result's key set, say).

---

## Known gaps

- **Only the two VizPick crosstabs are wired.** `digitallocks` (Power BI DAX),
  `livedashboard` (Hoops tRPC) and `sparkscango` all parse remote shapes and
  should be wired the same way. Each needs its own baseline entry.
- **Columns only.** A source that keeps its column names but changes a
  column's *meaning* — units, a metric redefinition — is invisible here. The
  same 2026-08-22 republish also carried a banner announcing a change to Pick %
  itself; the shape watch would not have caught that. Range/sanity checks on
  known-stable ratios would be the next layer.
- **No alerting.** Detection lands in Firestore and the debug panel; nothing
  emails or posts. A scheduled query against `suite_schema_drift` filtered to
  `stillParsed: false` is the obvious next step.
