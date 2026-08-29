# APAISuite backend

Deploy config for the **`apaisuite`** Firebase project. This directory is not
part of the extension package — it exists so the project's Firestore rules are
version-controlled next to the code that writes to them.

## Shape: one project, one database per module

```
apaisuite (project)                     ← one project = ONE anonymous-auth identity
├── (default)          suite-wide telemetry     firestore.suite.rules
│     suite_usage_events
│     suite_schema_drift
└── digitalmetrics     that module's data       modules/digitalmetrics/backend/firestore.rules
      stores/{store}/…
      metrics/…
```

Why databases rather than collection prefixes or a `/modules/{id}/…` path:

- **Isolation that rules enforce.** Each database has its own rules file, so a
  mistake in one module's rules cannot expose another's data. Prefixes put
  every module in one rules file, where a wrong `match` reaches everything.
- **Names stop colliding.** `stores` inside the `digitalmetrics` database
  cannot clash with the next module that wants a `stores` collection, so no
  module needs its paths rewritten to join the suite.
- **One auth identity per project.** Anonymous auth is per *project*, so N
  databases still means one Firebase user and one token cache for everything
  in `apaisuite`. Splitting a module across a *second* project would add
  another sign-in, so don't.

  This paragraph used to claim `shared/usage_metrics.js` kept the suite to one
  sign-in by borrowing aurorbuddy's client. It did — but aurorbuddy's client
  is pinned to the `aurorbuddy` project, and the rules for `suite_*` deploy
  *here*. So every suite telemetry write returned **403 PERMISSION_DENIED**
  for as long as that held, absorbed by each writer's retry queue and visible
  only as a repeating console error. Fixed by giving the suite its own client
  at `shared/suiteBackend.js`, which signs in to `apaisuite`. Sharing a token
  cache is worth nothing if it points at the wrong project.

**Adding a module later** is additive and touches nothing existing:

```bash
firebase firestore:databases:create <module> --location nam5 --project apaisuite
# add a { "database": "<module>", "rules": "..." } entry to firebase.json
firebase deploy --only firestore --project apaisuite
```

## Deploying

`firebase.json` and `.firebaserc` live at the **suite root**, not here. The
Firebase CLI rejects any rules or indexes path outside the directory holding
`firebase.json` ("is outside of project directory"), so a copy in this folder
could not reference `../modules/digitalmetrics/backend/` at all.

From `unified-extension-suite/`:

```bash
firebase deploy --only firestore --project apaisuite
```

Both databases' rules go up together. To do one:
`--only firestore:digitalmetrics`.

`scripts/release.sh` strips `backend/` directories plus `firebase.json` and
`.firebaserc` from the shipped extension. Rules describe exactly which
documents are reachable and under what conditions; shipping them hands that map
to anyone who unzips the package, and nothing loads a `.rules` file at runtime.

## Not in here

`aurorbuddy` keeps its own project and its own rules. Its `tool_events` /
`tool_workflows` / `tool_metric_events` carry analyst names and emails and have
a live dashboard reading them, so moving that data buys nothing and risks a
working system. Only the suite-wide `suite_*` collections move here.

## One-time setup steps

Neither is scriptable with the Firebase *CLI*:

1. **Enable Anonymous auth** — Authentication → Sign-in method → Anonymous.
   Every write in both databases requires `request.auth != null`.

   The CLI can't do it, but the Identity Toolkit **admin API** can, and on a
   Walmart machine that is the only route: the corp proxy blocks Google web
   sign-in for personal accounts, so `console.firebase.google.com` is
   unreachable while the API is not (`firebase projects:list` works). Use:

   ```bash
   node scripts/enable-anon-auth.mjs            # report current state
   node scripts/enable-anon-auth.mjs --enable   # turn it on
   ```

   It reuses the CLI's existing login, so no browser is needed. The other way
   round the block is a phone on cellular rather than corp wifi.
2. **Create a Web App** to obtain the public web `apiKey` for
   `modules/digitalmetrics/lib/config.js`.
