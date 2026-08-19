# Follow-up brief: recover two sheetdocId GUIDs

This supersedes `vizpick-missing-data-brief.md`. That investigation is **done** —
all eight ring values were located and their columns confirmed. One thing is
still missing, and it is the only thing blocking headless pulling.

**Read-only. Do not modify, save, or publish any Tableau content.**

**Throttle yourself.** The previous session got rate-limited / connection-dropped
by the host after rapid-fire export and probe requests. This whole brief needs
**one** dialog request. Do not loop, do not retry quickly, and if anything
returns a connection error, stop and wait rather than retrying.

---

## What is already settled (do not redo)

| Sheet | Carries | sheetdocId |
|---|---|---|
| `VizPick Donut Health` | composite + Cases / Locations / Picks / Overstock | **UNKNOWN — needed** |
| `Department Groups Donuts Health` | Fresh / F&C / GM, via a `Department Group` column | **UNKNOWN — needed** |
| `Download Location Details` | detail rows | `{DE528639-7176-4925-BBC6-CD07ECC646F1}` |
| `Download Department Breakout (Current Day)` | detail rows | `{95A7AC48-BC4F-432B-9590-5A424FF72939}` |

Column mapping is confirmed and the parsers are written and tested. The
extension can render the card the moment it can request those two sheets.

## The one open question

`POST {base}/sessions/{SESSION}/commands/tabsrv/export-crosstab-server-dialog`
returns every sheet's GUID, but rejects a multipart body carrying only
`telemetryCommandId` with:

```
missing: thumbnail-uris
```

**I need the exact request body Tableau's own UI sends to that endpoint.**

I have already guessed at `thumbnail-uris` = `[]` in the extension. That guess
is unverified — this brief is how we find out what the real value is, rather
than probing the host repeatedly to discover it.

---

## Task — capture the real request (one click, no scripting)

1. Open the dashboard and let it fully load:
   `https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails`
2. Open DevTools → **Network**. Filter to `crosstab`.
3. Click Tableau's own **Download → Crosstab** button, so the sheet-picker
   dialog opens. **Stop there — do not download anything.**
4. Find the `export-crosstab-server-dialog` request that just appeared.
5. Right-click it → **Copy → Copy as fetch**.

**Deliverable:** paste that verbatim. It contains the exact body, which is what
I need. Redact any cookie/auth header before pasting — I only need the body.

If "Copy as fetch" is unavailable, open the request's **Payload / Request** tab
and paste the raw multipart body, including the field names and boundaries.

### Also useful, from the same request

6. Click the **Response** tab on that request and paste the section listing the
   sheets — specifically the entries for `VizPick Donut Health` and
   `Department Groups Donuts Health`, so I get both GUIDs directly.

That may make the body question moot: if the GUIDs are stable, hardcoding them
alongside the two known ones is enough, and the dialog call becomes optional.

---

## Deliverable format

```
## Request body
<verbatim, cookies redacted>

## GUIDs
VizPick Donut Health              {GUID}
Department Groups Donuts Health   {GUID}

## Notes
<anything that 403'd, rate-limited, or looked different from the above>
```

## Why both halves are worth capturing

The GUIDs alone unblock this today. The request body is what keeps it working:
if Tableau republishes the workbook the GUIDs change, and live resolution is
what recovers automatically instead of silently falling back — which is exactly
the failure mode that hid this for so long.
