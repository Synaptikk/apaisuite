# DigitalMetrics

Digital fulfilment performance analytics, schedule import, and the daily task
assignment grid — packaged as an [APAISuite](https://qrcallbox.com/extension/)
module (MV3 browser extension).

Ported from a standalone Firebase web app. The port's defining constraint:
**associate names are never stored in the database.**

> **This repo is a mirror of `modules/digitalmetrics/` inside the APAISuite
> extension.** The module runs as part of that extension, not standalone.
> Changes made here need porting back, and vice versa — there is no automatic
> sync.

**Status:** All 9 tabs ported. Not yet exercised against a live browser.

```bash
npm test              # 177 tests, no dependencies
npm run audit:names   # fails if a real associate name leaked into the source
```

Everything is plain ESM with no build step and no npm dependencies. `npm test`
uses the Node built-in test runner.

## What makes this module different

**Associate names are never stored in the database.** Each associate is written
as `{ t, n }` — an HMAC token for joining and an AES-GCM ciphertext for display
— and decrypted in the browser. Read `docs/PRIVACY.md` before
touching anything under `lib/`; several things that look like ordinary
refactors will silently orphan every historical record.

The two rules that keep that guarantee real:

1. `lib/firestore.js` is the only file that may build a Firestore request.
2. `lib/codec.js` rebuilds every document from a field allowlist, so leaking a
   name requires deliberately adding it to an allowlist rather than merely
   forgetting to strip it.

`lib/names.js::canonical()` is **frozen**. Read the header before editing it.

## Layout

```
lib/
  config.js        backend identity — the ONLY place a project id appears
  crypto*.js       HMAC tokens + AES-GCM display names
  names.js         canonicalisation (frozen) + device-local alias table
  codec.js         document encode/decode — the choke point
  firestore.js     REST adapter — the only network caller
  data/            pure logic: weeks, parse, metrics, adherence,
                   classify, opportunities
  pages/           one renderer per tab: render(ctx) -> html, wire(ctx, root)
backend/           rules + indexes SCHEMATIC for the future project (not deployed)
```

## Port status

All nine tabs render from real data. Excel ingest, schedule import, the
assignment grid, autosave, finalise and print are wired.

**Not ported, deliberately:**

- **SheetJS** — replaced by `vendor/xlsx_min.js` (7.5KB, vendored from
  metricshot and extended here with multi-sheet support). SheetJS is 881KB and
  would have had to be vendored too, since MV3 forbids the CDN tag the donor
  used.
- **Flatpickr** — replaced by a native `<input type="date">`. The donor used it
  to mark which dates have data; that indicator is gone. Restore it by
  vendoring Flatpickr if the marking turns out to matter.
- **The scraper's Tableau automation** (~3,500 lines driving the viz through
  tab automation). The pure transforms are ported and tested
  (`lib/data/tableau.js`), and `content/tableau_capture.js` exposes the viz API
  to the SW, but the end-to-end "open tab, apply filters, page through dates"
  driver is not yet rebuilt.
- **Mobile layout.** The grid has a touch task panel and scrolls, but the
  donor's phone-specific breakpoints were not carried over — the suite is a
  desktop sideload.

## Gotchas specific to this module

- **The backend target is interim.** `lib/config.js` points at the legacy
  project so the port can be exercised against real data. The shipping project
  does not exist yet. Anything written before it does has to be migrated twice
  — prefer read-only (`digitalmetrics.writerEnabled = false`).
- **No server-side query by associate.** Tokens live inside array elements,
  which Firestore cannot index. All per-associate filtering, sorting and search
  happens client-side after decryption.
- **Fuzzy name matching operates on plaintext**, after the adapter decodes.
  Tokens are exact-match only and could never do it — which is why
  canonicalisation lives at the storage boundary, not in `data/adherence.js`.


## Repo layout

```
module.js service.js view.js view.html styles.css   the APAISuite module contract
lib/            privacy layer, pure data logic, page renderers
lib/tests/      177 tests (node --test)
backend/        Firestore rules + indexes SCHEMATIC — not deployed
content/        MAIN-world Tableau content script
tools/          audit_names.mjs — leak check
vendor/         7.5KB dependency-free .xlsx reader
docs/           PRIVACY.md, SCHEMA.md
```

## Start here

- **[docs/PRIVACY.md](docs/PRIVACY.md)** — how names are kept out of the
  database, what that protects against, and what it explicitly does not.
  Read before touching anything in `lib/`.
- **[docs/SCHEMA.md](docs/SCHEMA.md)** — the Firestore layout, provisioning
  checklist, and the query consequences of encrypting names.

## Status

All nine tabs are ported and unit-tested. **The module has not yet been loaded
in a browser** — everything here is verified by test and static resolution, not
by running the extension. That is the next gate.
