# Brief: recover the VizPick headline data we aren't pulling

You have a browser with a live, signed-in session to a Walmart Tableau
dashboard. I need you to identify where five headline numbers and three
department numbers come from, so an extension can pull them headlessly.

**This is a read-only investigation.** Do not change any Tableau content, do
not save or publish anything, do not alter workbook settings. You are reading
what the page already loads.

---

## The page

```
https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails
```

Add `?Store=<storeNumber>` to scope it to one store. The dashboard is titled
**"VizPick Backroom Health"**.

## What I need, exactly

The dashboard renders eight rings. I can currently get **none** of them.

| Ring | Label on the dashboard | Goal shown | Notes |
|---|---|---|---|
| Large, left | `VizPick Health` | none | composite score, integer (e.g. `96`) |
| Small, under it | `Fresh` | none | integer (e.g. `97`) |
| Small, under it | `F&C` | none | integer (e.g. `97`) |
| Small, under it | `GM` | none | integer (e.g. `94`) |
| Grid | `Cases` | `Goal 95%` | percent (e.g. `97%`) |
| Grid | `Locations` | `Goal 95%` | percent |
| Grid | `Picks` | `Goal 90%` | percent |
| Grid | `Overstock` | `Goal 90%` | percent |

`Fresh`, `F&C` and `GM` are the three I care most about — I have no idea what
underlying field produces them, and I must not guess a
department-number-to-group mapping for a report that gets posted to staff.

## What already works, so you don't rediscover it

The viz is server-side rendered: **row data is not in the bootstrap JSON.**
The only proven way to get real rows is to replay Tableau's
*Download → Crosstab* request sequence:

1. `POST {base}/sessions/{SESSION}/commands/tabsrv/export-crosstab-server-dialog`
   → JSON listing every downloadable worksheet as
   `"sheetName":"...","sheetdocId":"{GUID}"`
2. `POST {base}/sessions/{SESSION}/commands/tabsrv/export-crosstab-to-csvserver`
   with body `sheetdocId={GUID}&sendNotifications=true&telemetryCommandId={rnd}`
   → JSON carrying `genExportFilePresModel.resultKey`
3. `GET {base}/tempfile/sessions/{SESSION}?key={resultKey}&keepfile=yes&attachment=yes`
   → the file bytes (CSV text, or xlsx which is a ZIP)

`{base}` looks like
`https://stores.tableau.wal-mart.com/vizql/t/OnlineGrocery/w/<workbook>/v/<view>`
and `{SESSION}` is the session id — both appear in any `/vizql/` request URL in
the Network tab.

Two worksheets are already known and working:

| sheetName | sheetdocId |
|---|---|
| `Download Location Details` | `{DE528639-7176-4925-BBC6-CD07ECC646F1}` |
| `Download Department Breakout (Current Day)` | `{95A7AC48-BC4F-432B-9590-5A424FF72939}` |

Neither contains the eight numbers above. **I expect there is a third
worksheet that does** — step 1 will tell us.

---

## Task 1 — list every downloadable worksheet (do this first)

Open the dashboard, open DevTools → Console, and run:

```js
// Find the vizql base + session from any request the page already made.
const u = performance.getEntriesByType("resource")
  .map(e => e.name).find(n => n.includes("/vizql/") && n.includes("/sessions/"));
const base = u.slice(0, u.indexOf("/sessions/"));
const session = u.slice(u.indexOf("/sessions/") + 10).split(/[/?]/)[0];
console.log({ base, session });

const boundary = "----probe" + Math.random().toString(36).slice(2);
const body = `--${boundary}\r\nContent-Disposition: form-data; name="telemetryCommandId"\r\n\r\n`
  + `${Math.random().toString(36).slice(2)}$probe\r\n--${boundary}--\r\n`;
const r = await fetch(`${base}/sessions/${session}/commands/tabsrv/export-crosstab-server-dialog`, {
  method: "POST", credentials: "include",
  headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body,
});
const text = await r.text();
console.log("status", r.status);
console.log([...text.matchAll(/"sheetName":\s*"([^"]+)","sheetdocId":\s*"(\{[0-9A-Fa-f-]+\})"/g)]
  .map(m => `${m[1]}  ${m[2]}`).join("\n"));
```

**Deliverable 1:** the complete `sheetName → sheetdocId` list, verbatim.

If the regex prints nothing but the status is 200, paste the first 3000
characters of `text` instead — the response shape may have changed and I can
adapt the pattern.

## Task 2 — export the sheet that carries the headline numbers

Pick the most likely sheet from Task 1 (something like "Download Summary",
"Download Store Health", or similarly named) and export it:

```js
const SHEETDOC = "{PASTE-GUID-HERE}";
const cmd = `${base}/sessions/${session}/commands/tabsrv/export-crosstab-to-csvserver`;
const fd = new URLSearchParams({
  sheetdocId: SHEETDOC, sendNotifications: "true",
  telemetryCommandId: Math.random().toString(36).slice(2) + "$probe",
});
const r2 = await fetch(cmd, { method: "POST", credentials: "include",
  headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: fd });
const j = await r2.text();
const key = /"resultKey":\s*"([^"]+)"/.exec(j)?.[1];
console.log("resultKey", key);

const r3 = await fetch(`${base}/tempfile/sessions/${session}?key=${key}&keepfile=yes&attachment=yes`,
  { credentials: "include" });
console.log((await r3.text()).slice(0, 4000));
```

**Deliverable 2:** for each sheet that contains any of the eight numbers —
the **header row** and **two data rows**, verbatim.

I need the exact column headers. Whether the column is called `VizPick`,
`VizPick Health` or `VizPick Score` decides whether my parser finds it.

## Task 3 — if no worksheet carries them

Then they are computed in the viz rather than exported, and I need the
presentation model instead. In the Network tab, filter to `/vizql/`, reload
the dashboard, and look for responses from `bootstrapSession` or
`ensure-layout-for-sheet` / `render-tooltip-server`.

Search those responses for the literal strings `Fresh`, `F&C`, `GM`,
`VizPick Health`, `Overstock`.

**Deliverable 3:** the request URL and a ~2000-character excerpt around each
hit, so I can see the JSON path the values sit at.

A cheaper alternative that may settle it faster: **hover a ring and screenshot
the tooltip.** Tableau tooltips usually name the underlying field, which tells
me what to look for.

## Task 4 — confirm what Fresh / F&C / GM actually are

If Task 1 or 2 reveals them, say which column. If not, hover each of the three
small rings and report the tooltip text verbatim. I specifically need to know
whether they are:

- a distinct field on the same row as `VizPick Health`, or
- an aggregation of the department rows I already pull (in which case I need
  the department-to-group mapping, from the tooltip or a legend — **not
  inferred from department numbers**).

---

## Deliverable format

Reply with these four sections. Raw text, no summarising — I am pattern-matching
against exact strings:

```
## 1. Sheet list
<sheetName  sheetdocId, one per line>

## 2. Sheet contents
### <sheetName>
<header row>
<data row 1>
<data row 2>

## 3. Presentation model (only if 2 came up empty)
<request URL>
<excerpt>

## 4. Fresh / F&C / GM
<tooltip text or column name, verbatim>
```

## Notes

- Store numbers and store-level operational metrics are fine to include.
- Do not include anything identifying a person — no names, emails, or WIN IDs.
  If a response contains them, redact before pasting.
- If a step 403s or returns HTML, say so and paste the status; that usually
  means the session id is stale and the page needs a reload.
