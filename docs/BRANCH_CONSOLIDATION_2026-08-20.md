# Branch Consolidation — 2026-08-20

**Status:** HISTORICAL. Explains why the repo's branches looked the way they
did on 2026-08-20 and which of two competing approaches "won" in each area.
Not a spec of current behavior — read the files themselves for that.

## What happened

Local `master` had an unrelated git history from every remote branch (root
commit had the same message as `origin/apaisuite`'s but a different hash —
consistent with a local repo re-init at some point), yet had independently
converged on nearly the same tree through parallel work. Separately,
`origin/apaisuite` had **properly merged** `vizpick/market-rollup` and
`workvivo-auth-and-sendbird-hardening` via real merge commits, then continued
~40 more commits of work local `master` never saw: dark-mode theme, a
settings module, telemetry, security-hardened host permissions, and active
Chrome Web Store submission prep.

`master` was reset to point at the real `origin/apaisuite` tip (`6650379`).
The only things ported forward from the old local history were three modules
`apaisuite` never received — `market120`, `sparkrisk`, `sparkscango` — plus
their supporting `shared/` helpers. The old local history is preserved at
`backup/local-master-2026-08-20` (local-only branch, not pushed) in case
anything else needs to be recovered later.

## Competing approaches — which one is live now

### MetricShot: screenshot automation → rendered card

Old local history's `modules/metricshot/lib/cdp.js` + `workvivo_upload.js`
drove a real Tableau tab and uploaded a screenshot through Workvivo's UI
(Sendbird's REST API rejects file messages for this app — 400 "File-messages
via SDK are disabled"). **This is gone.** `origin/apaisuite` replaced it
entirely with `lib/rasterize.js` + `lib/render_card.js` + `offscreen.html/js`:
it draws an SVG reproduction of the VizPick dashboard from the actual
Tableau export data (not a screenshot) in an offscreen document, then posts
that. No UI automation, no screenshot capture, no CDP. Simpler and avoids the
file-message block by never uploading a file-shaped thing that isn't text.

### Sendbird auth: mint-per-call → sniffer + rotation-survival

Old local history's `sendbird.js` had moved to minting a fresh Session-key on
every call (`GET /api/chat/config` → open a Sendbird WebSocket → read the key
from the LOGI handshake), explicitly to avoid "scraping" / "a fragile network
sniffer." **`origin/apaisuite` went the other way** — it kept the sniffer
(`content/wv_session_sniffer.js` sets `window.__APAISUITE_METRICSHOT_SBKEY`
by watching the page's own traffic) and hardened it with the
`workvivo-auth-and-sendbird-hardening` branch's fix: a `sbFetch()` chokepoint
that retries once on 401/403 after waiting up to 3s for the sniffer to
observe a rotated key.

**This wasn't reconciled — it's a live fork in reasoning, not a resolved
decision.** If you're touching `sendbird.js` next, worth confirming with
whoever did this apaisuite-side work whether the sniffer was kept
deliberately (e.g. the mint-per-call WebSocket handshake proved unreliable)
or was just what was already there when the rotation fix got merged in and
nobody revisited it.

### Distribution channel: qrcallbox.com-only claim is now stale

`CLAUDE.md` and `docs/AI_CONTEXT_BRIEF.md` currently say the Chrome Web Store
path was deferred and qrcallbox.com is the only channel. `origin/apaisuite`'s
recent commits contradict that: `scripts/pack-cws.sh`, `scripts/check-cws.mjs`,
a CDP driver for the CWS dashboard, a privacy policy, store screenshots, and
commits explicitly building an `apaisuite-chrome` variant that drops
native-messaging modules (`claimsbuddy`, `licenseintake` — CWS doesn't allow
native messaging hosts) and narrows host permissions for store review. This
looks like real, active CWS submission work, not exploration. **`CLAUDE.md`
and `AI_CONTEXT_BRIEF.md` need a rewrite of the "qrcallbox.com is the only
channel" section** — confirm the actual CWS status with the user before
editing it, since this doc says what it says on purpose per
`MEMORY.md::Update channel`.

### Host permissions: wildcards → explicit hosts

`*.walmart.com/*` and `*.wal-mart.com/*` wildcard host permissions were
replaced with an explicit per-service list (security hardening, presumably
for CWS review — Google flags broad wildcard hosts). `manifest.json` remains
the source of truth per project convention; `docs/PERMISSIONS_MATRIX.md` was
already flagged STALE and this widens the gap further.

### Settings: ad hoc `userStore.js` → a real settings module

Old local history's `shared/userStore.js` (home-store auto-detection from a
cached Auror JWT) is superseded by a proper settings module — home store,
market, role, and per-module visibility — landed 2026-08-19. Existing
`getUserHomeStore()` / `getUserHomeMarket()` callers should be checked
against whatever the new settings module exposes; they may now be redundant
fallbacks rather than the primary path.

## Unresolved from this consolidation

- `shared/marketRoster.js` and `shared/cvSchedule.js` were carried forward
  with `market120`/`sparkrisk`/`sparkscango` but have **zero importers**
  anywhere in the tree right now — dead code, or wiring that never landed.
  Confirm intent before relying on either.
- `modules/sparkrisk/content/capture.js` and
  `modules/sparkscango/content/powerbi_ssg_capture.js` were declared in each
  module's `module.js::manifest.contentScripts` but were **never present**
  in the old local history's actual `manifest.json` — meaning on that
  machine, neither content script ever actually ran. They've been added to
  the top-level `manifest.json` now (matching the module.js declarations),
  but this is unverified — test both before relying on them.
