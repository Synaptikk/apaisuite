# Auror page integration plan (V2)

V1 of LicenseIntake never touches an open Auror page directly. Everything
lives in the suite's full-page module view. Page-level integration is a
deliberate V2 — this doc captures the plan so we don't rebuild it from
scratch when the time comes.

## Goal (V2)

When an operator is already on an Auror page (a person record, a case,
the global header), give them a one-click way to:

1. **Open License Intake pre-armed** from an inline Auror button.
2. **Push the scanned LicensePerson back into the Auror page** — populate
   the New Event form, search the person identity field, attach the
   license image as evidence.

## Why we deferred it

AurorBuddy's current Auror automation is **all imperative**:
`chrome.scripting.executeScript({ world: "MAIN" })` from the service
worker, injecting a `driveForm` function written for `/event/new`'s
React tree. No declarative content script, no in-page button. To add a
persistent inline UI element we either need to:

- A. Add a declarative content script that mutates the Auror page DOM
  (brittle — Auror is React-rendered, and any selector change breaks us)
- B. Use AurorBuddy's existing imperative pattern but trigger it from
  the suite's full-page module (works today; just not "inline")

Option B is what V1 ships. Option A is the V2 work below.

## V2 design

### 1. Declarative content script

```js
// modules/licenseintake/content/auror_inline.js
// Adds an "Import driver's license" pill to the Auror header.
```

Top-level `manifest.json` content_scripts entry:

```json
{
  "matches": ["https://app.us.auror.co/*", "https://*.auror.co/*"],
  "js": ["modules/licenseintake/content/auror_inline.js"],
  "run_at": "document_idle"
}
```

`module.js::manifest.contentScripts` mirrors it for documentation.

### 2. Inject pattern

Resilient mount loop (mirrors how Walmart's own internal extensions deal
with React rerenders):

```js
function tryInject() {
  if (document.getElementById("li-inline-import")) return;
  const header = document.querySelector("header[data-locator='global-header']");
  if (!header) return;
  const btn = document.createElement("button");
  btn.id = "li-inline-import";
  btn.textContent = "Import DL";
  btn.addEventListener("click", () => chrome.runtime.sendMessage({
    module: "licenseintake",
    type: "open_full_page",
  }));
  header.appendChild(btn);
}
new MutationObserver(tryInject).observe(document.body, { subtree: true, childList: true });
tryInject();
```

Style scoped to a `#li-inline-import` ID — minimal CSS, color it with
the module accent.

### 3. Service-worker handler

`service.js` gains `open_full_page(_, sender)` which opens the suite's
own URL (`chrome.runtime.getURL("app.html") + "#licenseintake"`) in a
new tab, with the source Auror tab id remembered for later push-back.

### 4. Push-back from intake → Auror tab

When the operator selects an Auror person on the intake view, V2 surfaces
a "Send to Auror tab" button. The handler:

```js
host.messaging.sendToTab(aurorTabId, "li_apply_person", {
  identityGroupId, pNumber, displayName,
}, { fallbackScripts: ["modules/licenseintake/content/auror_inline.js"] });
```

The content script receives, finds the person-search field, calls the
React-aware `setReactValue` helper (copied from
`aurorbuddy/lib/auror_event.js`), submits the search, picks the row.

### 5. Evidence attach (further V2)

If we can verify Auror's evidence-upload XHR shape (POST multipart to
`/api/spa/Event/<id>/attachments` or similar), `licenseintake` can attach
a saved license image. The AurorImport extension already produces the
PNG with a stable filename pattern. AurorBuddy does NOT have an upload
adapter — this is greenfield. Plan:

- Capture the Auror evidence-upload XHR via a webRequest watcher to
  reverse the request shape on a manual upload first.
- Then implement programmatic upload behind a new handler
  `attach_license_image(sessionId, blob)` with confirmation gate.

## Operator confirmation pattern (carry from V1)

Every page-side write needs the same confirmation contract V1 already
enforces:

```js
{ confirmed: true, dryRun: false }
```

Without both, the adapter rejects.

## Failure modes to design around

| Failure | Mitigation |
|---|---|
| Auror React rerender removes our injected button | MutationObserver re-mounts; idempotent (`if (document.getElementById(...))`) |
| Auror selector changes (header data-locator drift) | Fall back to `<header>`, then to floating bottom-right button |
| Content script not yet injected when push-back fires | `host.messaging.sendToTab(..., { fallbackScripts: [...] })` already handles re-injection |
| Operator closes Auror tab between intake and push-back | Detect via `chrome.tabs.get(id)` failing; surface "tab closed — open Auror and retry" |
| Auror auth expired mid-flow | `_jwtReader.get()` returns null → same "open Auror to refresh" message we already show in the intake search step |

## What this requires before V2 starts

1. A signed-off design review for the declarative content-script mutation
   (Auror operations team may have rules about injection).
2. Reverse-engineering of the Auror evidence-upload endpoint (one
   manual capture session in DevTools, ~30 min).
3. Updated `host_permissions` in `module.js` if Auror auth requires
   anything beyond what AurorBuddy currently captures.
4. Test plan for selector-drift detection (probably a periodic
   self-check that the inline button still mounts).

Nothing else from V1 needs to change to enable V2.
