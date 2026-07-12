# APAISuite Changelog

All notable changes to APAISuite are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
