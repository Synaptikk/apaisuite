# Research task: remove `chrome.debugger` from sparkfraud without breaking SSO

You are researching a Chrome MV3 extension. Do not write the fix yet — investigate,
then report ranked options. Say "unverified" where you are inferring rather than
citing. Prefer citations to Chrome developer docs, the Chromium bug tracker, or
Chrome enterprise policy docs over general recollection.

## Goal

Drop `"debugger"` from the extension's `manifest.json` permissions. It is the single
most review-hostile permission on the Chrome Web Store, and sparkfraud is now the ONLY
remaining consumer of it in the codebase. Everything else has already been migrated off.

## The two things that still need CDP

Both are in `modules/sparkfraud/service.js`.

### Use 1 — `_spoofVisibility(tabId)`

```js
await chrome.debugger.attach({ tabId }, "1.3");
await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
  source: `
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
  `,
});
```

Purpose: the extension drives an SSO chain (`pfedprod.wal-mart.com` -> Okta ->
`gscope.walmartlabs.com`) in a tab opened with `active: false`. Chrome throttles timers
and defers promise microtasks in hidden tabs, and intermediate SSO pages stall on their
own JS. The override must apply to EVERY document in the redirect chain, which is why
`addScriptToEvaluateOnNewDocument` was chosen over a one-shot injection.

I believe this one is straightforwardly replaceable and want that confirmed or refuted:
elsewhere in this same codebase the identical override was moved into a **declared**
MAIN-world `document_start` content script and works. The open question is whether a
declared content script reliably wins the race against the page's own scripts across a
multi-hop redirect chain, and what happens on hops whose host is not in the match list.

### Use 2 — `_clickGoViaCdp(tabId)` — the hard one

```js
const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
  expression: `/* find and .click() a submit/Go/Continue button */`,
});
```

The in-code comment documents why, and this is the constraint the whole task turns on:

> Click the Go submit button via CDP Runtime.evaluate (not chrome.scripting).
> Why: Walmart-corp Edge MDM policy makes chrome.scripting.executeScript hang
> indefinitely on gscope.walmartlabs.com/api/wmstoresso for BOTH isolated and
> MAIN worlds (verified live via CDP probe — raw Runtime.evaluate works fine,
> but chrome.scripting times out). Same family of breakage as the gutted
> chrome.cookies.getAll({}) that necessitates readCookiesViaTab.

So: in the managed environment this ships into, `chrome.scripting.executeScript` **hangs
forever** (not throws) on that specific origin/path, in both worlds, while raw CDP
`Runtime.evaluate` on the same tab works. A related API, `chrome.cookies.getAll({})`,
is similarly broken there and already has its own workaround (`readCookiesViaTab` in
`shared/auth.js`).

The existing non-CDP fallback in `_clickGoViaCdp` calls `auth.clickSso(tabId, ...)`,
which routes through `chrome.scripting` — i.e. **the fallback is precisely the API
documented to hang.** Removing `debugger` without a real replacement would silently
regress SSO for every user on a managed device.

## What I want back

1. **The likely mechanism.** What enterprise policy or managed-browser configuration
   would make `chrome.scripting.executeScript` hang indefinitely on one origin while
   CDP still works, and also gut `chrome.cookies.getAll({})`? Name the specific policy
   or feature if you can (`RuntimeBlockedForUrls`, `URLBlocklist`, extension
   `runtime_blocked_hosts` / `policy_blocked_hosts` in `ExtensionSettings`, DLP
   connectors, or something else). `runtime_blocked_hosts` is my leading hypothesis —
   confirm or refute it, and explain why it would produce a HANG rather than an error,
   and why CDP would be exempt.

2. **Ranked replacement options** for Use 2, each with: mechanism, why it might or might
   not evade the same policy, MV3 legality, and how confident you are. Consider at least:
   - a **declared** content script (injected by the browser, not via the scripting API)
     that listens for a message and performs the click
   - `chrome.scripting.registerContentScripts` (dynamic but still the scripting API —
     does the policy gate registration, injection, or both?)
   - performing the click from a content script already resident on an earlier hop
   - `chrome.debugger`-free navigation: is the "Go" click even necessary, or can the
     form's target URL be constructed and navigated to with `chrome.tabs.update`?
   - anything that removes the need to touch that origin at all

3. **A verification plan.** The failure only reproduces on a managed corporate device.
   Tell me exactly what to run there to distinguish "policy blocks the scripting API"
   from "policy blocks this origin for extensions entirely", including what
   `chrome://policy` should be checked for. Cheap decisive tests first.

4. **The honest fallback.** If no replacement is dependable, say so plainly. An
   acceptable outcome is "keep `debugger`, or ship sparkfraud only in the self-hosted
   build" — I would rather hear that than a clever fix that breaks SSO in production.

## Constraints

- Manifest V3, service worker (`"type": "module"`). No remote code, no `eval`, no
  `new Function` — the CSP forbids them and the store rejects them.
- Must work with the tab **backgrounded** (`active: false`) and with **no user
  interaction** — this runs on an alarm.
- Cannot add a permission scarier than `debugger`.
- The target environment is managed Edge/Chrome under corporate MDM. I cannot change
  the policy; assume it is hostile and fixed.
