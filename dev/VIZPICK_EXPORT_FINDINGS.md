# VizPick — is the crosstab export the slow way round?

**Investigated 2026-08-21**, live, against the analyst's authenticated Edge
profile over CDP (`localhost:9222`) by reading the capture ring that
`modules/vizpick/content/tableau_capture.js` already maintains. Read-only:
no navigation, no clicks, nothing driven.

## The question

The VizPickDetails page paints visible numbers within a second or two, but our
Today crawl costs ~18s per store driving Download → Crosstab → CSV. If the
rendered numbers arrive as data, the export is redundant.

## Answer part 1 — the data is NOT in the browser. Do not try to parse it.

`renderMode: "render-mode-server"`.

The viz is **server-side rendered**. Tableau rasterises the marks on the server
and ships an image. The page looks instant because it is a picture, not because
a dataset arrived.

Evidence from the live `bootstrapSession` response (387,993 bytes):

| Check | Result |
|---|---|
| `dataDictionary` | present but **`{}`** — empty |
| `dataValues` / `dataColumns` | absent everywhere in the payload |
| `isDeferredBootstrap` | `false` (so nothing is deferred to a later data fetch) |
| Second length-prefixed block | 20 bytes — `{"secondaryInfo":{}}` |

The things that *looked* like data were not:

- **Marker hits were static text.** "Suggested Picks", "Pick Anyway",
  "Cases Expected", "Total Picked" all appear inside dashboard caption and
  tooltip zones (`zoneText`, `<formatted-text>`), not in any value array. This
  is the exact false-match `findBlobBySubstr()` was written to avoid — see the
  comment in `tableau_capture.js`.
- **The "long numeric run" was layout geometry** — `yHeights:[20,20,20,…]`
  (row pixel heights) and `[[68,0],[84,0],…]` widths.

**So the export is not an inefficiency, it is the only route by which the
values cross the wire.** Any future "just parse the vizql" idea should be
closed by pointing here.

### Bonus: the dashboard's own definition of Pick %

Recovered verbatim from a caption zone in the same payload, which settles the
`Total Picked` question from earlier that day:

> "Cases Picked using 'Pick Anyway' are not factored into the Pick % metric
> since they are not system generated suggested picks."

and the header text: `On Hand Picks / Suggested Picks Goal 90% (30% wt.)`.

## Answer part 2 — but the export IS being driven the slow way

The export is not an opaque UI flow. It is three plain HTTP steps, all caught
in the ring:

1. `POST …/commands/tabsrv/export-crosstab-server-dialog`
   multipart, body carries only `telemetryCommandId`.
   **Note:** in the captured run this returned
   `commandValidationPresModel: { valid: false, errorMessage: "Error …" }`
   and the export still completed — so this step may be skippable outright.
2. `POST …/commands/tabsrv/export-crosstab-to-excel-server`
   multipart body is just:
   `sheetdocId` = `{95A7AC48-BC4F-432B-9590-5A424FF72939}`, `sendNotifications`,
   `telemetryCommandId`.
   Response returns:
   ```json
   { "resultKey": "3227845031",
     "fileName": "Download Department Breakout (Current Day).xlsx",
     "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
   ```
3. `GET …/sessions/<sessionId>?key=<resultKey>&keepfile=yes&attachment=yes`
   → the file bytes (`PK\x03\x04`, an xlsx).

A second sheet in the same session used
`sheetdocId = {DE528639-7176-4925-BBC6-CD07ECC646F1}` →
`"Download Location Details.xlsx"`, `resultKey 3227845030`.

### What that would remove per store

Everything the current source does with the DOM: hovering the visual, clicking
the per-visual More-options button, waiting for the dialog, matching the sheet
thumbnail *by name*, selecting the CSV radio, clicking Export, and then
`waitForVizReady(DIALOG_SETTLE_MS = 20_000)` for the toolbar to come back
before the second sheet. Twice per store.

Replay is: one POST, one GET, per sheet.

The per-store cost that would REMAIN: setting the Store parameter and waiting
for the viz to re-query. That is irreducible — the workbook is scoped to one
store by a parameter and the server has to re-run the query.

### Verified live against a real session (2026-08-21)

| Test | Result |
|---|---|
| `POST export-crosstab-to-excel-server` on a **live** session | **HTTP 200 in 181 ms** |
| Same POST on a **stale** session (idle ~2h) | **HTTP 410 Gone** |
| `POST export-crosstab-server-dialog` with only `telemetryCommandId` | `valid: false, errorMessage: "Error in param…"` |

So the command path is real and fast, and it is **session-scoped** — a 410 is
the signal to re-establish, not a failure.

### Everything needed is on the page — do not hardcode it

The viz frame exposes `window.tsConfig`:

```
sessionid       <REDACTED>            <- live session credential, never commit one
site_root       /t/OnlineGrocery
repositoryUrl   VizPick/VizPick          <- "<workbook>/<view>"
workbookLastPublishedAt  2026-07-20T19:07:48.192Z
```

which composes the base URL directly:

```
https://stores.tableau.wal-mart.com/vizql{site_root}/w/{workbook}/v/{view}/sessions/{sessionid}
```

**Frame gotcha:** the two views differ. `…/views/VizPick/VizPick` (the portal
hash-router URL) runs the viz in an **iframe**, so `tsConfig` is absent from
the top frame and a top-frame-only evaluation sees an empty page. The
`…/t/OnlineGrocery/views/VizPick/VizPickDetails?:embed=y` form puts it at top
level. Anything reading `tsConfig` must walk frames. The extension's content
script is already declared `all_frames: true`, so it is unaffected — but dev
tooling is not.

### The one unsolved piece: where `sheetdocId` comes from

`export-crosstab-to-excel-server` needs `sheetdocId`, a GUID naming the sheet:

| GUID | Sheet |
|---|---|
| `{95A7AC48-BC4F-432B-9590-5A424FF72939}` | Download Department Breakout (Current Day) |
| `{DE528639-7176-4925-BBC6-CD07ECC646F1}` | Download Location Details |

It is **not** obtainable from the dialog command (that errors without a param
we have not identified), and the GUIDs in the bootstrap payload are zone and
image ids, not sheet doc ids — checked, they sit next to `"Navigation"` and
`"zoom-icon 1.png"`, not sheet names.

**This does not block the work**, because it is exactly what capture-and-replay
is for, and the plumbing already exists:

1. Drive the DOM export dialog **once per session** — the code path that runs
   today.
2. `content/tableau_capture.js` already records `reqBody` on every patched
   fetch, so the outgoing multipart body carrying `sheetdocId` is already in
   the ring. No new instrumentation.
3. Replay POST+GET for every subsequent store.
4. On HTTP 410, re-learn (session died) — the same shape as the auth-retry
   logic in `shared/auth.js`.

So the cost becomes one DOM dialog per market instead of two per store.

### Risks before building it

- **Is `sheetdocId` stable?** It looks workbook-scoped and may change when the
  workbook is republished. Mitigation is the existing capture-and-replay
  pattern (as in `digitallocks`): drive the dialog once per session to learn
  the GUID, then replay for every store.
- **Does the replay need the dialog POST first?** The captured run suggests
  not — step 1 errored and step 2 still worked — but that needs a clean test.
- **Format changes to xlsx.** The captured `resultKey` fetch returns xlsx, not
  the CSV the current flow selects. `digitallocks/lib/xlsx.js` already reads
  xlsx in-house and would need to move to `shared/` on a second consumer.
- **`sessionId` is per-session** and already known to the source.

### Suggested next step

Prototype against ONE store and measure end-to-end against the current
~18s/store, before touching the crawl. If the saving is real it applies to
every store in the market, and it also removes the Blob interception and
download-suppression machinery, since the bytes come back to a plain `fetch`.

## A note on what not to write down

The `sessionid` above is redacted on purpose. It is not an identifier — it
authenticates the export calls in this document for as long as it lives, so a
real one pasted into a repo is a credential in git history. The sheet GUIDs
and `site_root` are workbook structure and are safe; session ids, and anything
else that would let a reader replay a call, are not.

## How this was checked

Zero-dependency CDP evaluation against the already-open tab — `puppeteer-core`
is not installed in this repo and Node 24 has a global `WebSocket`, so the
existing puppeteer probes were not needed. `fetch("http://localhost:9222/json/list")`
→ find the page target → `Runtime.evaluate` against
`window.__APAISUITE_VIZPICK_TABLEAU_CAP.all()`.
