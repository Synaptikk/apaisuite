# APAISuite Changelog

All notable changes to APAISuite are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.7] – 2026-09-15

Covers everything since the 1.0.5 / 1.0.6 releases on 2026-09-14, including
six Register L/S commits that landed after the 1.0.6 version bump.

### Headline

- **Two new modules:** BoB and Lisa (missed-item finder) and Safety Agent Dashboard (SafeIQ camera hazard alerts).
- **Market 120 repaired and extended:** Clearance/Deleted loads again and matches Tableau to the dollar; stores are clickable; ISA now shows real Market 120 figures with a new interactive ISA review.
- **Power BI numbers no longer inherit someone's saved report filters.** Market 120 ISA and Live Dashboard Recognition now build their own queries (shared builder in `shared/pbi_query.js`). The old approach had been showing store 1458's ISA figures and Market 29's stolen dollars on the Market 120 page, and undercounting Safety Observation engagements.

### Added — BoB and Lisa (`boblisa`, new, alpha 0.2.0)

"Bottom of Basket / Look Inside Always": finds customers who paid, then paid again minutes later for an item the cashier missed.
- Scans a whole EJ store-day for pairs: same card token, second sale 1–15 minutes after the first, fewer than 5 items and at least $3. Split into manned lanes 9–25 (cashier miss) and other registers (possible theft).
- Training receipts from Money Center / Vision Center are matched to purchases by UPC; unmatched training receipts get their own tab.
- **Document this miss** on any row (cause, how it was caught, video review, cashier, drafted note), kept per store across re-pulls; **Documented misses** tab by cashier with CSV export.
- **Find APPRISS video** (Open Drawer route with a time-based fallback) and CCTV links from store + register + time.
- Excludes same-register sales under 2 minutes apart and money services; Automotive and Money Center second sales hidden by default.
- Technical: analysis runs inside an ej.walmart.com tab (a store-day is ~10 MB); frozen tabs are reloaded first. Store 1458's register map only, for now.

### Added — Safety Agent Dashboard (`safetyagent`, new, alpha 0.1.0)

- SafeIQ computer-vision hazard alerts for one store across all dates: which cameras keep firing on nothing, who closes alerts, and how fast.
- Camera × disposition pivot, associate response times, hour-of-day chart, expandable no-hazard events.
- Technical: SafeIQ Studio SQL endpoint from the service worker with captured SafePass token (SSO tab fallback), per-store cache, image cache and single-flight guards. New SafeIQ host permissions.

### Market 120 (`market120`)

**Fixed — Clearance / Deleted**
- Clearance/Deleted numbers load again. Tableau draws the KPI cards as images and the crosstab CSV export arrived as UTF-16, so neither was readable. The pull now reads the "CD Store" sheet through Tableau's data API in a **background tab** — no focus change, no export dialog. The tiles come from the store totals; the national figure is the sum of all stores. Verified: all 10 Market 120 stores match Tableau to the dollar.
- Pulls can't hang: page-script timeouts and a 4-minute cap with a `TIMEOUT` badge; the previous error clears when a new pull starts.
- Tableau saves a user's filter state server-side. The store pull now clears any leftover Store filter first and refuses a result with fewer than 500 stores nationally (`FILTERED`) instead of saving a partial market.
- "Refresh all" no longer races two exports on the same Tableau tab; its spinner no longer shows while idle.
- Removed the page subtitle.

**Added — store detail**
- Click a store in the week-over-week table: totals, rank, share of market, gap to market average, Deleted-on-Clearance $, weekly history, and item detail from Tableau "CD Location Details" (top departments, locations and 25 items). Item totals reconcile to store totals. The Store filter used for the detail is reset afterwards.

**Changed — ISA (all figures were the wrong scope before)**
- The old tiles read the reports' own cards, which carried saved slicers: ISA Detail was saved on store 1458, and Backroom Adjustments on Market 29 — "Stolen Adj $ $46,758" was Market 29's. Market 120 fiscal-year stolen is **−$400,300**.
- ISA now builds its own Power BI queries filtered to Market 120, in its own background tabs (never a Power BI tab you have open), with per-report tokens cached in session memory.
- **New ISA review panel** under the ISA tiles: 7 / 14 / 28-day window ending on the latest date with data; reason chips (RFID, Pinpoint, Nil Pick, Deep Scan Out, ISA, Out of Stock); summary cards; six-week daily trend; top categories and departments; sortable store table. Expand a store for reasons, categories, adjustment sources, its top items, and Backroom **Stolen** detail by user, category and item.
- Tile labels corrected ("Total Adjusted Units", "Stolen Adj $ (FY)") with a scope line underneath.
- Verified live in the extension: refresh ~19 s without changing focus; store rows sum to the market total; store 1458 item detail reconciles to the cent (−$109,478.13); reason filter, sorting and 7-day window work.

### Live Dashboard (`livedashboard`)

**Fixed — Safety Observations (Recognition / Engagement)**
- Now builds its own Power BI query (store, observation type, last 14 days) instead of reusing the report's. The report's query carried the viewer's saved store, a store-tier filter (G1–G3 only) and a 500-row cap that it was already hitting.
- **Engagement counts were too low.** Engagements have no description text, so every engagement on a day collapsed into one row. Store 01458 showed 9 engagements in 14 days; the real number is 32 (store 01215: 14 vs 57). Recognition counts were unaffected and match exactly.
- Any store now works directly, with no store-number text swapping.

### Register L/S Triage (`registerls`)

- **Committed after 1.0.6:** associate pantry runs without a CFT (flagged as "CFT never completed", store-looking baskets only, a found cause with a ready disposition, every cash ticket on the day checked, a pantry run means 10+ pantry lines across 3+ products); receipt parser reads two-letter item flags.
- CFT candidates must be $100+ and made of pantry-list items.
- **Pantry list** card: add your store's own pantry UPCs, then re-analyze.
- **"This was the cause" picker** on any transaction row writes the More Information text and a ledger charge.
- New verdicts: **possible multi-entry offset** (review only), **outside the reports' window**, and an **amount differs** note when WorkView and Power BI amounts disagree.
- Report pulls now accumulate history across pulls (each source reaches back ~60 days).

### VizPick (`vizpick`)

- **Added:** Pick progression dialog for the home store — open picks by last scanner's job, every open bin with name, WIN, title and shift, per-update timeline, first/not-yet-scanned sections, CSV export.
- **Fixed:** another store's associates could be filed under the home store (Tableau silently dropped the Store change); the crawl now waits for Tableau to confirm the store and history rejects foreign bin lists.
- **Fixed:** dozens of Tableau tabs left open overnight — capture tabs are reaped after 40 idle minutes and page-script calls time out.
- Background checks run 5 AM to midnight only. Workday title lookups for the "D" badge are switched off (Workday's URL search no longer returns results).

### Digital Metrics (`digitalmetrics`)

- **Added:** Express Orders and Express Picks columns (and summary cards) in Insights → Daily Picks, from Tableau Store Fulfillment Scorecard.
- **Fixed:** a partial pull no longer wipes the rest of the week (week documents merge on write).
- Tableau reading shared in `lib/sources/tableau_driver.js`.

### Smaller fixes

- **Closing List:** CaseVisibility sign-in recovery (fresh sign-in tab, one retry, 30 s timeout, cleaner error messages); settings save as soon as you change them.
- **Spark Fraud:** check off order items (greyed, moved to the bottom, remembered across searches).
- **APPRISS sign-in** link fixed (no longer ends on a Cloudflare block or the logon page).
- **Workday** title parsing handles the new profile-page redirect.

### Shared / infrastructure

- `shared/pbi_query.js` + `shared/parse_dax_grid.js`: build Power BI semantic queries and decode results (moved from Market 120 now that a second module uses them). Tests: `shared/tests/pbi_query.test.mjs`.
- `shared/tableau_lock.js`: suite-wide lock so VizPick and Digital Metrics Tableau captures run one at a time.
- Market 120 Power BI capture now records request auth headers in page memory (never persisted).
- New tests: ISA review model, Recognition query, Tableau lock, BoB and Lisa, Closing List, Safety Agent, VizPick home history, Digital Metrics Express. All module unit tests pass.

### Known issues

- **Market 120 alert thresholds** were set when ISA read a single store. At market scope both ISA alerts show critical ($824K vs $800K; $400K stolen vs $30K) until recalibrated.
- The ISA review's category/department table styling fix was not re-checked visually.
- A Tableau outage that returns a partial national table will show as `FILTERED`.
- VizPick wrong-store fix verified in the debug profile only.
- BoB and Lisa video lookup only tested down the sign-in error path; register map is store 1458's only.
- Register L/S still fills the WorkView disposition form in a background tab; its EJ tab reuse can hang on a frozen tab.
- Digital Metrics Firestore rule edits are not confirmed deployed.

---

## [0.8.5] – 2026-06-14

### Added — ORC Corridor Monitor (new module)

A new **`orcmonitor`** module that identifies ORC actors whose event histories show directional movement toward a target store along Southeast US interstate corridors.

**Core intelligence:**
- Searches all 8 Southeast BU Auror regions (2, 3, 9, 11, 12, 14, 29, 42) for ORC-flagged events
- Fetches full `PersonProfile` + `ProfileFeed` from Auror for each identified actor
- Builds per-person store-visit timelines with exact dates and coordinates
- Uses **direction vector analysis** (not just distance comparison) to distinguish genuine corridor approach from local cluster activity — filters out actors operating in a tight geographic cluster who merely happen to be slightly closer due to store layout

**Trajectory math improvements over naive distance:**
- Cluster radius filter: persons whose events fit within a 25-mile radius >100 miles away are flagged as "Local operator" rather than approaching
- Direction vector consistency: requires ≥40% of consecutive moves to point within 60° of target bearing
- Minimum 30-mile net displacement to qualify as approach
- Interstate corridor alignment bonus: events on the same I-75/I-24/I-40 corridor toward target raise risk score

**Risk scoring (0–100):**
- Proximity (distance to target) — 40 pts max
- ETA credibility — 25 pts max
- Recency of last sighting — 20 pts max (⚡ if ≤7 days)
- Trajectory quality — 10 pts max
- Corridor alignment — 10 pts bonus
- Threatening behavior / crew size — additional pts

**Automatic Auror authentication:**
- If no JWT is cached, opens `app.us.auror.co` in a background tab, auto-clicks SSO, captures token, closes tab — no manual steps required
- Token captured via shell's `webRequestFilters` on every Auror request; 20-minute TTL

**Progressive card rendering:**
- Cards appear as each person profile loads (every 1.5 s) rather than waiting for all 60 profiles to complete

**Interactive map:**
- Leaflet map (bundled locally, no CDN; OSM tiles with `crossOrigin:"anonymous"`)
- I-75/I-24/I-40/I-59/I-65/I-81/I-85/I-20/I-26 corridor overlays
- 200-mile alert radius ring around target store
- Threat dot markers color-coded by risk score (red/orange/yellow)
- Card click → highlights card + shows that person's chronological store path on the map with trajectory arrow

**PDF/print export:**
- Canvas-based map capture: draws OSM tiles + corridors + radius ring + threat dots + arrows using Leaflet's `latLngToContainerPoint()` projection — accurate pixel alignment with live map
- Report opens as an extension page (`report.html`) and auto-triggers the print dialog
- Includes person photos, store history, time-of-day heatmap bars, ORC corridor tags, MO breakdown
- Capped at top 20 actors by risk score
- 3 cards per page layout

**Filters applied:**
- Only actors with at least one event within 300 miles of target
- Single-event actors excluded unless within 100 miles
- Store history capped at 300 miles (distant events summarized as count)
- Stale actors (>45 days since last seen) have ETA suppressed

**"Name Unknown" fallback** — actors without a confirmed Auror identifier display as "Name Unknown" rather than blank

### Changed

- **`manifest.json`** — description updated to include ORC Corridor Monitor; version bumped 0.8.4 → 0.8.5
- **`modules/_registry.js`** — `orcmonitor` added to module list, positioned after `aurorbuddy`

### Module files added

```
modules/orcmonitor/
  module.js          Module manifest (webRequestFilters, accent, ui, service)
  service.js         SW handlers: getStatus, analyzeThreats, getPersonDetail
  view.js            Dashboard UI: map, cards, progressive render, PDF export
  view.html          HTML shell for the module view
  styles.css         APAISuite light-theme card + map styles
  report.html        Standalone print page (opened by Export PDF)
  report.js          Report HTML generator + auto-print
  lib/
    auror_api.js     Auror REST client (JWT from session storage)
    corridors.js     Interstate waypoints + haversine + nearest-corridor
    store_coords.js  Known Walmart store coordinates + SE BU region list
    trajectory.js    Per-person trajectory analysis (direction vectors, cluster filter)
    leaflet.js       Leaflet 1.9.4 bundled locally (148KB, no CDN dependency)
    leaflet.css      Leaflet styles bundled locally
```

---

## [0.8.4] – 2026-06-07

AurorBuddy backend migration phases 1.1 and 1.2: corrected `suspectTotalValue` / `finalEventValue` schema separation; new SW handlers for workflow lifecycle; Mark Submitted UI.

---

## [0.8.3] and earlier

See git log.
