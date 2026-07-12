# Directory Lookup — Probe Findings

> One-off investigation 2026-05-31. The goal was to find a username → real-name
> resolver for the claimsdisposition module's per-user breakdown.
> Scripts in this folder (`probe-directory.mjs`, `probe-whois.mjs`,
> `probe-people-endpoints.mjs`, `probe-workvivo-users.mjs`,
> `probe-directory-form.mjs`, `snapshot-directory-page.mjs`) capture the raw
> findings. This doc summarises so the next person doesn't repeat the search.

## Endpoints tried — none cleanly viable as-is

| URL pattern | Result | Notes |
|---|---|---|
| `one.walmart.com/content/uswire/en_us/directory.html?q=<u>` | Renders the directory landing page, ignores `q`. Form submit doesn't trigger any XHR that resolves the username. | The page has a search form (`#directory-search-form`, `#qinput`, `#searchbtn`) but its submit handler appears to be a no-op or routes through some client JS not fired by puppeteer. |
| `one.walmart.com/content/uswire/en_us/directory/directory-tools/who-is-search.html` | Redirects to **wd5.myworkday.com** (Workday SSO). | Workday is the canonical employee directory but requires its own API/auth handshake. Would need a separate integration. |
| `one.walmart.com/content/api/adp/internal/aisearch.json` (POST, `search_type: "uswire_all"`) | 200 — but returns CONTENT/document hits, not people. | `search_type: "people" / "users" / "person" / "directory" / "workvivo"` all return 403. |
| `one.walmart.com/content/api/adp/workvivoprofile.json?email=<email>` | 404 for every email shape tried (`ses008s@walmart.com`, `ses008s@wal-mart.com`, `ses008s.us@wal-mart.com`, `ses008s.s01458.us@wal-mart.com`). | Endpoint exists but the email-format-to-username mapping isn't obvious from the username alone. |
| `one.walmart.com/content/api/adp/{profile,user,userprofile}.json?{username,email}=…` | All 404. | Pure guesses; no match. |
| `workvivo.walmart.com/users/lookup?username=<u>` | 200 HTML — when the username is yours, redirects to `/` and the page renders YOUR profile (`<h2>` = name). **Problem:** for any unknown username it ALSO returns your own profile. Useless without a way to distinguish hit vs miss. | This is the most-promising lead. Open questions: does a DIFFERENT valid username redirect to `/users/<numericId>` instead of `/`? Need to test with a coworker's username. |
| `workvivo.walmart.com/api/v{1,2}/users/...` | 401 / 404. | Workvivo's REST API likely needs the Sendbird access-token auth, not just cookies. |

## Recommended next steps

1. **Test the Workvivo lookup with a coworker's username.** If for any valid non-self username Workvivo redirects to `/users/<id>` and the page shows THAT user's `<h2>`, the HTML-scrape approach in `lib/userDirectory.js::_fetchFromDirectory` becomes viable — we just need a way to distinguish "redirected to my own home" from "redirected to a real other user's profile."
   - One concrete distinguisher: check whether `location.pathname` starts with `/users/`. Self-redirect goes to `/`; matched-user-redirect should go to `/users/<id>`.
   - Verify by manually visiting `https://workvivo.walmart.com/users/lookup?username=<coworker_username>` in Edge and noting the final URL + page name.

2. **If Workvivo lookup is fundamentally a no-go**, try the Workday SCIM API (`wd5.myworkday.com/ccx/api/v1/walmart/Users?filter=userName eq "<u>"`). Workday SCIM is well-documented and the corp Workday tenant might expose user fetch with the same SSO cookies the browser already has.

3. **Fallback if both fail**: keep `lib/userDirectory.js` as-is (cache layer works; lookup returns null; UI shows usernames). Add a manual-edit UI in settings where the user pastes `username → name` rows and they get persisted to the same cache.

## What's already wired in code

- `modules/claimsdisposition/lib/userDirectory.js` — cache layer (chrome.storage.local, 30-day TTL hits / 24-h TTL misses), in-memory hot cache, in-flight dedupe, subscribe() event for re-renders.
- `_fetchFromDirectory` is the network stub — wire one of the approaches above into the body and the rest of the module + the drawer's user table will start showing names.
