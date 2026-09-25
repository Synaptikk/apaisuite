# SparkRisk — data foundations, scoring limits, and the Power BI blocker

**Written:** 2026-09-20 · **Module:** `modules/sparkrisk/` · **Model version:** `v3.1-timing-review` · **DB version:** 4

This is the handoff document for the SparkRisk foundation work. It covers what
the module actually knows, what its score does and does not mean, how the
storage migration behaves, and exactly what is blocking the audit-source
integration.

> **The headline, so nobody has to read further to get it right:**
> SparkRisk is a **timing triage queue**. It ranks recorded Spark trips so a
> human looks at the slowest-relative-to-reference ones first.
>
> It has now been checked once against real labels (§5c): of four
> Auror-confirmed theft orders at store 1458, **three scored essentially zero**
> because they were faster than the reference. **Do not describe it as fraud
> detection, and do not quote an accuracy number for it** - four positives
> cannot support one, and what evidence exists points the wrong way.

---

## 1. What the module ingests

There is **no automated extraction**. The old "Data Extraction" screen drove a
WISMO flow that does not work; it has been replaced by a local JSON import
(Import Data tab).

Import accepts either a bare array or `{ "orders": [ ... ] }`. Per record:

| Field | Required | Used for |
|---|---|---|
| `order_id` | **yes** | identity; records without one are rejected and counted |
| `store_nbr` (or `store_id` / `store`) | effectively yes | grouping, order identity, baseline scope |
| `pick_started_time` | **yes**, ISO | trip start; also supplies `extraction_date` (first 10 chars) |
| `dispatched_time` | **yes**, ISO | trip end; must be strictly later than `pick_started_time` |
| `total_order_qty` | **yes**, `> 0` | item count; coerced with `Number()` |
| `trip_id` | no | groups multiple orders into one trip; falls back to the order id |
| `driver_uuid` → `driver_id` → `driver_pseudonym` | no | driver identity, in that priority order |
| `picked_time` | no | derives `review_window_start` (the suggested video window) |
| `status` | no | anything matching `/cancel/i` makes the trip unscoreable |

Timestamps must be **strings** that `Date.parse` accepts. Numeric epoch values
are rejected on purpose — an unlabelled number is as likely to be seconds as
milliseconds, and guessing wrong silently produces 1970 trips.

### Retained vs. scored

A record that fails any of the above is **kept in the `orders` store** and
simply excluded from trip building. It is counted and surfaced as
"Orders not scored" on the Overview and in the import result. Nothing imported
is ever discarded except records with no `order_id`, which are counted as
`rejected`.

---

## 2. Identity and grouping

```
order identity   = JSON [store, order_id]
trip grouping    = JSON [store, pick date, driver key, trip_id | "order:<id>"]
session_id       = "trip:" + JSON [store, pick date, driver key, trip_id | order_id]
driver key       = driver_uuid || driver_id || driver_pseudonym || "unknown:<order_id>"
baseline scope   = JSON [store, driver key]
```

Consequences worth knowing:

- **Order numbers are only unique within a store.** Everything that joins on an
  order id — `getSession`'s order lookup included — is scoped by store. A
  lookup on `order_id` alone will pull another store's order into the trip.
- **A driver at two stores is two histories.** Baselines, the queue's driver
  counters and the detail panel's driver stats all scope by `(store, driver)`.
- **Unknown drivers are isolated.** `unknown:<order_id>` is unique per order, so
  unidentified trips never pool into a shared fake driver and never contribute
  to or receive a baseline.
- **`session_id` is a JSON array and contains double quotes.** It must be HTML
  escaped before it goes into an attribute. It previously was not, which
  terminated the `data-session` attribute early and stopped rows opening.
  `modules/sparkrisk/lib/rendering.test.mjs` guards this.

---

## 3. What the score is

```
expected_ms   = 60s × combined_items          ← ARBITRARY REFERENCE CONSTANT
excess_min    = (duration_ms − expected_ms) / 60000
excess_score  = clamp(excess_min × 2, 0, 100)                     weight 0.4
sigma         = max(prior_MAD × 1.4826, prior_median / 3)   ← stability floor
deviation     = (spi − prior_median) / sigma                      weight 0.3
                (needs ≥ 3 strictly earlier trips, same store, same driver)
priority      = weighted mean of whichever components exist, clamped 0–100
```

### The sigma floor

`prior_median / 3` is a **lower bound on the deviation scale**, added
2026-09-20 after the runtime test below. Without it, a driver whose prior trips
cluster tightly produces a near-zero MAD and the z-score explodes: the sample
run produced **109 sigma from 8 trips**, which is not a number anyone should
read, store or act on. The floor is the same scale the old `median / 3`
fallback used when MAD was exactly zero, so that branch is now the limiting
case of this one rather than a separate rule.

This is a numerical-stability guard, not a calibration — but **it does change
rankings**, because the deviation term was previously saturating its clamp for
almost any low-variance driver. Before/after on the sample set:

| Trip | Before | After |
|---|---|---|
| steady driver's genuine outlier | dev 109.5 → score 100 | dev 10.9 → score 80.4 |
| habitually-slow driver's identical outlier | dev 39.3 → score 100 | dev 2.7 → score 62.9 |
| steady driver's ordinary day (5 min *under* reference) | score 7.5 | score 0.5 |

If this turns out to be unwanted, it is one constant:
`MIN_SIGMA_FRACTION_OF_MEDIAN` in `lib/sessions.js`.

### What is deliberately *not* in the score

| Removed / absent | Why |
|---|---|
| Peer percentile | **Never implemented.** No peer source is mapped. The column has been removed from the queue rather than rendering a permanent `—`. |
| `is_peak_1to4`, `is_weekend` multipliers | Dead code — `buildSessionFromOrders()` has never written either field, so the branches never fired. |
| Batch-size multiplier (`order_count > 3 → ×1.1`) | This one **did** fire and had no support. A bigger batch already raises `expected_ms` through `combined_items`; multiplying again double-counted batch size. Removing it is why the model version went `v3 → v3.1`. Scores from before are not comparable. |
| `confidence` (low / medium / high) | Renamed to `history_coverage` (`none` / `limited` / `recorded`). It only ever described how many prior trips backed the baseline. Calling that "confidence" invited reading it as confidence that something was wrong. |

### Limits to state out loud

1. **60 s/item is a made-up constant.** Not fitted to this store, these
   departments, order composition, or anything else. A 40-item produce-heavy
   order and a 40-item GM order get the same expectation.
2. **Nothing is calibrated.** There is no labelled outcome set, so there is no
   precision, no recall, and no threshold that means anything. The 45 / 60 / 75
   score bands are display colours, not decision boundaries.
3. **Baselines only see imported data.** A driver working for six months with
   one imported day has one day of history. `history_coverage` reports this;
   the badge says LIMITED HISTORY, not "new driver".
4. **Ties are excluded from baselines.** Only trips with a *strictly earlier*
   `session_start` contribute, so a batch of simultaneous trips cannot bootstrap
   a baseline off each other.
5. **`picked` and `dispatched` are source statuses.** They are not observed
   register arrival or store exit. The UI copy was changed accordingly, and
   `register_time_ms` keeps its name only for DB back-compat — it is labelled
   "picked-to-dispatch" everywhere a human sees it.
6. **There is no audit log.** "Resolve real order numbers" writes one line to
   the service-worker console and nothing else. The help text now says so.

---

## 4. Storage and migration

`modules/sparkrisk/models/index.js`, DB `sparkrisk`, **version 4**.

| Store | Key | Notes |
|---|---|---|
| `orders` | `id` = `JSON [store, order_id]` | the auto-increment key from ≤ v3 is discarded on rebuild; it was never order identity |
| `sessions` | `session_id` | rebuilt from scratch on every import |
| `session_reviews` | `id` | `session_id` index is **non-unique as of v4** |
| `items` | `[order_id, item_id]` | OMS item cache, untouched by this work |
| `backups` | `id` | new in v4 |

### v3 → v4

- adds the `backups` store;
- **drops and recreates the `session_reviews.session_id` index as
  non-unique.** Under v3 it was unique, which would have aborted the entire
  rebuild transaction with a `ConstraintError` the first time an archived
  legacy review shared a `session_id` with a live one;
- `open()` now handles `onblocked` (rejects with an actionable message instead
  of hanging forever) and sets `onversionchange` (closes our handle so a newer
  version elsewhere can upgrade). The open promise is memoised so the shell
  page and the SW cannot race two upgrade transactions, and a failed open is
  not cached.

### The rebuild is atomic

`replaceAnalysis()` clears and rewrites `orders`, `sessions` and
`session_reviews` inside **one** transaction. A failure part-way through aborts
the whole thing and leaves the previous analysis intact — covered by
`models.test.mjs::a failed write aborts the whole swap`.

The first call also snapshots the pre-migration contents to
`backups/before-foundation-v3` and writes a `backups/foundation-v3-ready`
marker. The snapshot is written **once** and never refreshed, so it always
holds the original data, not an already-migrated copy.

### Review carry-over

On every rebuild, each legacy session is matched to a new one by order-id set:

1. **exact set match** wins outright;
2. otherwise a **subset match**, but only if it is the *single* candidate;
3. otherwise the review is **archived** — kept verbatim with
   `archived: true`, `original_session_id: <old>`, and a namespaced
   `session_id` of `archived:<review id>` so it can never be joined onto a live
   session or collide with a live review.

Archived reviews are excluded from the queue, from `getStats` counters and from
`getSession`. They are never deleted.

Where several legacy reviews land on one new session, the newest *meaningful*
one (status other than `new`, or with notes) becomes live and **all** of them —
including conflicting decisions — are preserved verbatim in `merged_reviews`,
which the detail panel renders in a collapsed `<details>`.

### The one case migration refuses

A database holding **sessions but no orders** (the shape v1/v2 shipped) cannot
be rebuilt — the orders are the only lineage there is. `ensureFoundation()`
declines, logs a warning, and leaves the analyst's queue alone rather than
emptying it. The next successful import supplies orders and takes over; the
orphaned reviews are archived at that point, not lost.

---

## 5. Tests

Run from `unified-extension-suite/` (there is **no** `package.json` at the
extension root — `npm test` there will fail):

```bash
node --test modules/sparkrisk/lib/sessions.test.mjs modules/sparkrisk/lib/rebuild.test.mjs modules/sparkrisk/lib/handlers.test.mjs modules/sparkrisk/lib/rendering.test.mjs modules/sparkrisk/models/models.test.mjs
```

| File | Covers |
|---|---|
| `lib/sessions.test.mjs` | trip validity (null / missing / reversed / equal / cancelled / zero-qty), `review_window_start` derivation, tied and future timestamps, `history_coverage` thresholds, score clamping, the removed batch multiplier, unknown-driver isolation, explanation wording |
| `lib/rebuild.test.mjs` | archive preservation and key uniqueness, exact-beats-subset migration, ambiguous matches archiving instead of guessing, re-import with changed status/notes/quantity, an order that becomes a cancellation, rejected records, reviews for zero-score sessions |
| `lib/handlers.test.mjs` | store-scoped order lookup and driver history, archived reviews excluded from queue/stats, `updateReview` by session id + status validation, date sorting, `getStats` counters, concurrent imports, the sessions-without-orders refusal |
| `lib/rendering.test.mjs` | `escapeHtml` behaviour, the `session_id`-in-an-attribute hazard, source-level guards that imported/OMS/reviewer fields still route through `esc()`, no peer/confidence rendering, no dead extraction controls |
| `models/models.test.mjs` | **real IndexedDB** via `fake-indexeddb`: v3 → v4 upgrade preserving rows, the unique-index replacement, atomic `replaceAnalysis`, one-time backup, abort rollback |

`fake-indexeddb` is a **devDependency of `dev/package.json`** (added by this
work). `models.test.mjs` resolves it from `dev/node_modules` and **skips its
whole file** if it is not installed, so the other four suites still run on a
machine where `dev/` has not been set up:

```bash
cd dev && npm install
```

`rendering.test.mjs` is partly a source-level lint. It cannot prove the view is
safe — there is no DOM in the test environment — it prevents the specific
known-bad patterns from returning. Treat it as a regression guard, not a proof.

**Status as of 2026-09-20: 44 tests, 44 passing.** `node --check` passes on
`module.js`, `service.js`, `view.js`, `lib/sessions.js`, `lib/rebuild.js`,
`models/index.js` and `content/capture.js`.

---

## 5b. Runtime verification, 2026-09-20

Run in the loaded extension in the debug Edge (`fchnolphfaklbpdgnofhblfhcailkpdb`,
which serves the **APAISuite-dev mirror** — copy changed files there first):

```bash
./dev/launch-edge-debug.sh
node dev/sparkrisk-sample-orders.mjs > /tmp/sparkrisk-sample.json
node dev/sparkrisk-e2e-probe.mjs /tmp/sparkrisk-sample.json
```

`dev/sparkrisk-sample-orders.mjs` builds a **diagnostic** order set: 33 records
containing planted cases whose correct treatment is known in advance. It is not
real data and contains no outcomes — it can only show the pipeline does what it
claims, never that the pipeline catches fraud.

### Confirmed working end to end

| Check | Result |
|---|---|
| Import through the real file input | 26 trips built, 32 orders stored, 4 retained-but-unscored, 1 rejected for having no `order_id` |
| Multi-order trip | 3 orders → 1 session, 33 combined items |
| Store scoping | the deliberately colliding order number at store 0999 stayed in its own session; the same driver got **0** prior history there |
| Unknown drivers | 2 unidentified trips stayed separate, no baseline given or received |
| Large batch, proportionally fast | 62 items / 48 min scored **0** — the removed batch multiplier confirmed gone |
| Row click | session ids survived the HTML attribute round-trip and the detail panel opened |
| Escaping | a planted `<img src=x onerror=...>` driver name rendered as literal text; no element injected |
| Review persistence | `confirmed` + notes survived a **full re-import and rebuild**, and a later scoring change |
| Re-import idempotence | 26 rows before, 26 rows after — no duplicate sessions |
| Charts | both canvases paint |

### Two defects the run exposed

1. **The import gate rejected a whole file over one bad row.** The view required
   *every* record to carry an `order_id`, while the service counts bad ones as
   `rejected` and proceeds — which made the "N record(s) rejected" line in the
   result panel unreachable. The view now requires only that *some* record is
   usable. One malformed row in a large export no longer forces hand-editing.
2. **`driver_deviation` was numerically degenerate** — see §3's sigma floor.

### What the run says about the ranking — read this before trusting the order

The planted slow trips did come out on top. That is circular: they were built
slow. The informative results are the blind spots the sample exposed.

- **Thin history outranks real evidence.** The #1 row (score 99.7) was a driver
  with a single prior trip, scored on excess time alone. The #2 row (80.4) was a
  driver whose eight prior trips *prove* the trip was abnormal for them.
  Knowing less about a driver pushes them **up** the queue.
- **Habitual slowness masks genuine anomalies.** Two drivers took an identically
  slow trip. The steady one scored 80.4 (deviation 10.9); the habitually slow
  one scored 62.9 (deviation 2.7) because their own baseline already expected
  slow. The driver you would most want flagged is demoted.
- **Habitual slowness also floods the queue.** The habitually slow driver's
  eight *ordinary* days occupied ranks 8–16, every one of them above every
  ordinary day of the steady driver. An analyst working top-down spends the
  session on one slow driver.
- **The 60 s/item constant decides almost everything.** Essentially every trip
  above it scores and every trip below it does not. Changing that one number
  reshuffles the entire queue.

None of these are bugs — they are what a duration-vs-fixed-reference ranking
does. They are the concrete reason the module must not be presented as fraud
detection, and the concrete argument for prioritising a fitted rate and an
outcome label (§7).

---

## 5c. First evaluation against real data and real labels, 2026-09-20

**This is the only evidence-backed statement about SparkRisk's ranking that
exists. It is not encouraging, and the sample is tiny. Read both halves.**

### Where the data came from

A standalone Spark-Risk tool predating this module holds a real WISMO corpus
and an Auror scrape:

```
C:\Users\ses008s.s01458\Desktop\Spark-Risk\app\spark-risk\spark-risk.db
C:\Users\ses008s.s01458\Desktop\Spark-Risk\analysis\theft\*.json
```

`dev/sparkrisk-from-standalone.mjs` converts it to the module's import format.
The standalone schema does **not** line up with the module's model - it has
`picking_start_time` / `picking_end_time` and no dispatch column - but every
row carries a `task_events` array with the real source status stream,
including exactly the three statuses the module is built around:

```
PICK_STARTED -> pick_started_time
PICKED       -> picked_time
DISPATCHED   -> dispatched_time
```

So the events are used, not the derived columns. `picking_end_time` equals the
PICKED event, which is seconds-to-minutes before DISPATCHED; using it as the
trip end would silently drop the picked-to-dispatch interval, which is the one
interval a reviewer can actually check on video.

Store 1458, 2026-06-19 to 2026-07-20: 10,787 rows -> 8,880 distinct orders
(1,907 duplicate order ids across extraction dates, deduped last-wins) ->
**5,778 scored trips**, 246 orders retained but not scored. Import took 7 s.

### How much ground truth actually reaches this corpus

| | count |
|---|---|
| Auror theft events at store 1458 in the scrape (2024-11-07 to 2026-07-21) | 32 |
| distinct order numbers across those events | 22 |
| events falling inside the WISMO pull window | 8 |
| labelled order ids present in the corpus | 6 |
| labelled orders that produced a **scored** trip | **4** |

Two of the six were `DELIVERY_CANCELLED` and so were retained but never
scored - see the blind spot below.

Note on what the label means: these are Auror theft events whose comments name
that order number. It has not been verified case by case that the driver was
the responsible party rather than, say, a customer claim.

### The result

Score distribution across all 5,778 trips:

```
min 0.0   p25 0.0   median 1.6   p75 10.1   p90 22.4   p99 60.3   max 100.0
  75-100:    21  (0.4%)
   60-75:    38  (0.7%)
   45-60:    84  (1.5%)
    0-45:  3446  (59.6%)
 exactly 0: 2189  (37.9%)
```

Where the four confirmed orders landed:

| order | rank / 5778 | score | items | s/item | excess | priorN | coverage |
|---|---|---|---|---|---|---|---|
| 200015085117002 | **140** (top 2.4%) | 45.6 | 27 | 111 | +22.8 min | 1 | none |
| 200014953338020 | 3445 (top 59.6%) | 0.2 | 20 | 58 | -0.7 min | 39 | recorded |
| 200014898990136 | 4703 (top 81.4%) | 0.0 | 11 | 54 | -1.2 min | 35 | recorded |
| 200014453289548 | 4834 (top 83.7%) | 0.0 | 46 | 55 | -4.2 min | 40 | recorded |

- in the top 1%: **0 of 4**
- in the top 5%: **1 of 4** (random would give 0.2)
- in the top 50%: **1 of 4**

### What this means

**Three of the four confirmed cases were faster than the 60 s/item reference
and scored essentially zero.** They are indistinguishable, by timing, from the
38% of trips that score exactly 0. Only one was slow, and that one had a
single prior trip - so it was ranked on excess time alone, not on any evidence
that it was abnormal *for that driver*.

On this evidence, **elapsed picking time did not separate confirmed theft from
routine trips at this store.** One case out of four beating chance is an
anecdote, not a signal - four positives cannot support a hit rate, a precision
or a threshold, and nothing here should be quoted as one. But it is a clear
result in one direction, and it is the opposite of what the module's ranking
assumes.

### A structural blind spot this exposed

Two of the six labelled orders were `DELIVERY_CANCELLED`, and the module
excludes anything matching `/cancel/i` from scoring by rule
(`lib/sessions.js::buildSessionFromOrders`). One of them had no DISPATCHED
event at all.

A cancelled delivery is a plausible theft pattern in its own right - goods
picked, delivery never completed. The module is currently **structurally
unable to surface it**, and a third of the ground truth available here sits in
exactly that state. Whether cancelled trips should be scored, scored
separately, or merely listed is a product decision, but the current silence is
not a neutral default.

### What to do with this

1. Do not widen deployment on the strength of the ranking. It has now been
   checked once and did not hold up.
2. The Auror scrape is a reusable label source. Pulling a WISMO window that
   covers more of the 32 events at this store - or pooling the other 85 stores
   in the scrape, 356 labelled orders in total - would give a sample that can
   actually support a measurement.
3. Re-run with `dev/sparkrisk-1458-eval.mjs` after any scoring change. It
   wipes the DB, imports, and prints ranks plus the full distribution.

---

## 6. Power BI audit source — BLOCKED, nothing verified

**Nothing about the Power BI audit reports has been verified in this session.
The adapters remain `DISCOVERY_REQUIRED` and no field mapping has been
invented.**

### What is actually known

The registry is `modules/sparkscango/lib/pages_registry.js`. Note that the IDs
circulating in the handoff notes are **page (section) IDs inside one report**,
not separate report IDs:

```
report  76bea7ea-fd3a-41d1-afff-4660a5999c1e
tenant  3cbcc3d3-094d-4006-9849-0d11d61f484d
pages   c9aa938e6bffd9b83dfe   spark_audits       (Spark Audits & Metrics)
        2ea55998cda7f3171c77   scango_audits      (Scan & Go Audits & Metrics)
        2db2baaa0eb0237b624e   spark_exceptions AND scango_exceptions
```

Every one of these is `status: STATUS_UNRESOLVED`. `selectNames` and
`bodyMarker` are `null` on all four.

### The blocker

- The in-app browser pane shows a Power BI **work/school sign-in** screen. I did
  not attempt to bypass it, inspect profile/token files, or work around the
  auth in any way.
- The debug Edge CDP route (`http://127.0.0.1:9222`, the documented way to reach
  the user's authenticated sessions on this machine) was **not running**:
  `curl` returns `Failed to connect to 127.0.0.1 port 9222`.

So there was no authenticated session to inspect, and therefore no way to
answer any of the open questions honestly.

### Also broken: the discovery contract points at files that do not exist

`pages_registry.js`'s header tells the next person to use
`dev/ssg_powerbi_probe.js` and to log findings in
`docs/SPARKSCANGO_DISCOVERY.md` / `docs/SPARKSCANGO_CHECKPOINT.md`.
**None of those three files exist in the repo.** Whoever resumes discovery has
to write the probe first, or the header is a dead end.

### Open questions, unchanged

1. Exact report/page labels as rendered (the registry itself flags that Spark
   and Scan & Go labels may be reversed).
2. Which `Select[].Name` fields carry item, driver, order, store and shortage.
3. Whether the audit rows can be filtered by transaction/order id — this is the
   join key SparkRisk would need to attach an outcome to a trip.
4. Pagination / `Window.Count` caps and export behaviour.
5. Which page actually holds actionable exception/audit rows (one page id is
   currently claimed by both products).

### How to resume

1. Start the debug Edge: `unified-extension-suite/dev/launch-edge-debug.sh`, and
   sign in to Power BI in it as the user normally does.
2. Confirm CDP: `curl http://127.0.0.1:9222/json/list`.
3. Drive the report over CDP (`puppeteer-core` is in `dev/node_modules`) and
   capture the QES POST bodies + `descriptor.Select[].Name` arrays per page.
4. **Build the query, do not replay it.** Power BI persists each user's slicer
   state per report; a replayed capture inherits whoever's filters were last
   applied and silently returns a slice. This has bitten this repo twice — see
   `dev/DIGITALLOCKS_PULL_FINDINGS.md` and the `powerbi-saved-slicers` note.
5. Paste verified mappings into `pages_registry.js` and flip `status` off
   `STATUS_UNRESOLVED` **per page**, only for pages actually observed.

---

## 7. What to do before calling any of this a detector

In priority order:

1. **Get an outcome label.** Until Spark audit rows (or shortage records) can be
   joined to a trip by order/transaction id, every number in this module is
   uncalibrated. This is the single blocking dependency.
2. **Replace the 60 s/item constant** with a rate fitted from the store's own
   history — probably per item-count band, possibly per department mix.
3. **Then, and only then,** revisit weights. Tuning `excessWeight` /
   `deviationWeight` against an unlabelled set is fitting noise.
4. Consider a durable audit log for identity resolution if this module is ever
   used on real driver identities at scale.

Until step 1 lands, the honest description of SparkRisk is the one in the help
modal: *a review queue ordered by how far a trip's elapsed time sits from a
fixed reference.*
