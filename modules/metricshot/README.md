# Metric Shots (`modules/metricshot`)

Scheduled screenshots of internal metric dashboards, posted into Workvivo channels using the user's already-authenticated tab. No credentials, tokens, or cookies leave the browser.

**Status:** beta · **Version:** 0.1.0

---

## What it does

1. On every configured local time slot (e.g. 10:00 / 14:00 / 20:00 daily), open or reuse a tab on the metric's URL.
2. Attach `chrome.debugger` and spoof `document.visibilityState = "visible"` so background-tab throttling doesn't stall Tableau / Power BI viz rendering (same pattern as `modules/sparkfraud/service.js:204-231`).
3. Wait for readiness (`document.readyState`, an optional `requiredSelector`, DOM-stability, then a configurable settle delay).
4. `Page.captureScreenshot` via CDP.
5. Sniff the PNG (signature, size, dimensions) and the page (`document.title` / `<h1>`) to refuse login/access-denied captures.
6. Post the image into the configured Sendbird group channel from inside the user's `workvivo.walmart.com` tab — primary path uses the loaded SendBird SDK, fallback uses Sendbird's REST API via MAIN-world `fetch`.
7. Record a deterministic run key so restarts + duplicate ticks never repost the same slot.

---

## Adding your first metric

The module ships with **VizPick Score** pre-seeded (see `data/defaults.js`), scheduled at **10:00 / 14:00 / 20:00 local, all days**, destination **"1458 Leadership"**. To add another:

1. Open APAISuite (toolbar icon) → sidebar → **Metric Shots**.
2. Click **+ Add Metric**.
3. Fill in:
   - **Name** — short display label
   - **URL** — https://…
   - **Schedule** — times (one per line, `HH:MM`, 24-hour) + day chips
   - **Workvivo channel name** — must match a channel you're a member of
4. (Optional) Expand **Advanced capture** to set `requiredSelector` (deterministic readiness), viewport size, settle delay, retries, catch-up window.
5. Click **Preview screenshot** to smoke-test capture without posting.
6. Click **Validate destination** to resolve the channel name → Sendbird channel URL.
7. **Save**.

The metric shows up in the table with Enabled toggled on. It will fire at the next scheduled slot without any further action.

---

## Preconditions for successful posting

- Edge/Chrome must be running (the extension SW needs to wake for the alarm), and you must be signed into Walmart SSO in this browser profile.
- **A `workvivo.walmart.com` tab is not required to be pre-opened.** If none exists at post time the module opens one in the background (`https://workvivo.walmart.com/chat`, `active: false`), waits up to 45 s for the SendBird SDK to bootstrap, does the post, then **closes the tab**. If you already had a workvivo tab open (e.g., you're chatting), we use it in place and leave it alone — user-opened tabs are never closed.
- The user must already be a member of the destination channel. The module never joins or creates channels.
- For Tableau pages: the target URL must be viewable without additional interactive filters. Query parameters (`:iid=1`, `?filter=...`) are preserved verbatim. The Tableau tab **stays open** across runs (reopening Tableau costs ~30 s of SSO + viz load, so tab-keeping there is worth it — unlike Workvivo, which we open fresh each time).
- If Workvivo bounces the newly-opened tab to SSO and doesn't finish signing in within 45 s (SAML MFA challenge, expired session), the post fails with a `NO_SDK` error and retries on the next scheduled slot. No screenshot is posted in that state.

---

## Storage layout

| Key | Scope | What |
|---|---|---|
| `metricshot.metrics` | `chrome.storage.sync` | Array of metric configs (small; syncs across signed-in Edge profiles). |
| `metricshot.postedRuns` | `chrome.storage.local` | `{ [runKey]: { status, at, path?, messageId? } }` capped at 500 entries; durable dedupe map. |
| `metricshot.lastStatus.<id>` | `chrome.storage.local` | Most recent run result per metric. |
| `metricshot.lastSuccess.<id>` | `chrome.storage.local` | Most recent successful post per metric. |
| `metricshot.lastPreview.<id>` | `chrome.storage.local` | Last preview PNG (base64), for the UI preview panel. One per metric. |
| `metricshot.seededOnce` | `chrome.storage.local` | Marker so we don't re-seed after the user empties the list. |

---

## Safety / auth policy

- **No credentials stored.** All auth is inherited from the user's existing SSO tabs.
- **No cookies, tokens, or headers logged.** `shared/logging.js` auto-redacts fields whose names match `authtoken|bearer|cookie|password|jwt|...` and this module's log emissions never include those fields anyway.
- **No mutating actions.** The capture pipeline reads the DOM, optionally hides configured selectors via a `<style>` tag, and takes a screenshot. It does not click buttons, submit forms, or navigate away from the metric URL — with the single exception of the shared `auth.clickSso` helper for landing-page SSO buttons.
- **Login-page detection.** If the tab lands on a URL that doesn't match the target, or if the target's title/H1 matches the login/SSO regex from `shared/auth.js`, the capture is refused and no screenshot is posted. Status becomes `AUTH` and the UI shows the warning pill.
- **Sensitive URLs not published.** The Workvivo message contains only the metric name, optional caption, `Captured: <local time>`, and the PNG. Never the source URL, never any request headers.

---

## Testing

Pure-function tests live in `lib/tests/*.test.mjs` and run without any browser:

```bash
cd unified-extension-suite
node --test modules/metricshot/lib/tests/
```

Covers:
- `scheduler.test.mjs` — schedule expansion, dedupe keys, catch-up window, DST edge cases, midnight crossings.
- `metrics.test.mjs` — config validation (URL, time format, weekdays, duplicate ids), normalization, defaults.
- `validate.test.mjs` — PNG signature / dimensions / size, auth-wall title/heading sniff.

CDP capture and Sendbird posting are impure and covered by manual QA (below).

---

## Manual QA checklist

Before the first real Workvivo post:

- [ ] Load unpacked extension in Edge (`edge://extensions`).
- [ ] Open APAISuite → sidebar → **Metric Shots**. VizPick Score is visible with a Daily 10:00 / 14:00 / 20:00 schedule.
- [ ] Click **Preview** — confirm the returned PNG shows the VizPick dashboard, not a login page or empty viz. (If no workvivo tab is open, the module opens one in the background automatically.)
- [ ] Click **Validate destination** in the edit form — confirm it resolves to a `sendbird_group_channel_*` URL for "1458 Leadership".
- [ ] With explicit approval only: click **Run now** — confirm ONE image message lands in the channel.
- [ ] Reload the extension (`edge://extensions` → reload icon) — the tick alarm and dedupe map survive.
- [ ] Confirm ClosingList, QRCallBox, and Live Dashboard still work — no regression.

---

## Known limitations

- `chrome.alarms` has a 1-minute minimum period in production. Posts fire within ~60 s of the target clock time, never earlier.
- The Sendbird SDK global name is not part of Workvivo's contract. If the SDK is bundled or renamed, the primary path breaks silently; the module falls back to the REST API (requires `https://api-*.sendbird.com/*` host permission).
- Tableau readiness detection is heuristic (readyState + selector + settle). Very slow viz loads may still capture partial renders. Set `requiredSelector` in Advanced to make readiness deterministic.
- If the machine is fully off at a scheduled time and the reboot happens more than `catchUpWindowMs` later, the run is skipped (`skipped-stale`) — this is intentional so you don't get a burst of stale posts on wake.

---

## Follow-up work

**Un-scanned bins text message on the 14:00 and 20:00 posts** (deferred).

Requirement: on posts *other than the first-of-day*, additionally send a text message listing every bin location whose Location Age > 6 h.

Implementation notes for whoever picks this up:

- The data is not in the DOM — Tableau renders the table on a `<canvas>`. It must be extracted from Tableau's own **VizQL response**. `modules/market120/` already does this (see the "NO_CAPTURE" error string the user shared). Read that module's content-script capture pattern first — reuse, don't reinvent.
- Add a per-schedule-slot `extras: ["unscanned-bins-message"]` field on the metric config (empty by default; UI can offer a checkbox: "Include un-scanned-bins message").
- After a successful image post, if the schedule slot has `unscanned-bins-message` in its extras AND the slot is not the first-of-day for that metric, do a second `sendbird.js` post using the same channel — but text-only (`sendUserMessage` instead of `sendFileMessage`).
- "First-of-day" = the earliest scheduled time for the metric that day. Compute this in `lib/scheduler.js` alongside the existing `expandDueRuns`.
- The text message body should be something like:
  ```
  Un-scanned bins as of 2:00 PM (Location Age > 6h):
  003/006 (23h) · 004/007 (26h) · 005/001 (27h) · …
  ```
  Cap the list at ~50 entries; if there are more, append `· (+N more)`.
- Threshold source: whatever numeric column Tableau exposes as "Location Age" in the highlighted-yellow rows in the target viz. Confirm the column key via `market120`'s VizQL probe.
