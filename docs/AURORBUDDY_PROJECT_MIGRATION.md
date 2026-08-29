# AurorBuddy → apaisuite project migration

Moving AurorBuddy's data out of its standalone `aurorbuddy` Firebase project and
into a named `aurorbuddy` database inside `apaisuite`, so the suite has one
backend instead of two.

**Status (2026-08-27):** steps 1 and 5 done, nothing cut over. No production
data has moved and the extension still writes to the old project.

| Step | State |
|---|---|
| 1. Create the database | **DONE** — `projects/apaisuite/databases/aurorbuddy`, nam5, matching `digitalmetrics`. Created with Firebase's default CLOSED rules, so nothing is exposed. |
| 2. Deploy rules | **DONE** 2026-08-29 — all three databases released to `apaisuite`. |
| 3. Copy the data | **DONE** 2026-08-29 — 222 docs, all 8 collections verified equal, then `firestore_config.js` flipped by `dev/cutover-aurorbuddy.mjs`. The extension now writes to `apaisuite/aurorbuddy`. |
| 4. Copy the auth accounts | **DONE** 2026-08-29 — 75 accounts exported from `aurorbuddy` and imported into `apaisuite`, uids preserved. Hash parameters came from `scripts/auth-hash-config.mjs`; the "only in the console" blocker was wrong (see §4). |
| 5. Dashboard reads both | **DONE, DEPLOYED 2026-08-29** — two Firebase apps, dual sign-in, merged and de-duplicated, with a source badge. Still **uncommitted** in `~/shanesmith`. |

**All five steps are done.** The extension writes to `apaisuite/aurorbuddy`,
the dashboard authenticates against both projects and merges them, and the
data is present in both.

Two loose ends, neither blocking:

- **`~/shanesmith/dashboard/` is deployed but uncommitted** (`app.js`,
  `index.html`, `styles.css`). The live site is ahead of that repo's history,
  so a fresh checkout would rebuild an older dashboard than the one serving.
- **Accounts and data now exist in BOTH projects, deliberately.** That is what
  lets legacy shanesmith installs in the field keep working. Retiring the
  `aurorbuddy` project is a separate decision that cannot happen until those
  installs are gone — see the shanesmith sunset in `BACKEND_MIGRATION_PLAN.md`.
  Until then, do not delete anything from the legacy project.

**`dev/migration-copy.mjs` is retired.** It writes by document id and would now
revert live rows. `dev/cutover-aurorbuddy.mjs` refuses to run for that reason.
| 6. Flip the extension | Blocked on 2-4. One line in `firestore_config.js`. |
| 7. Retire | Later. |

---

## The decision that shapes everything

**Firebase ID tokens are project-scoped.** The `aud` claim is the project id, so
a token minted by project A is rejected outright by project B's Firestore — no
rule can accept it, because the token never gets that far.

That single fact drives the whole design:

- The dashboard must read the NEW database (post-cutover suite writes) *and* the
  OLD one (legacy shanesmith installs that cannot be redirected remotely).
- Those are different projects, so it needs **two authenticated Firebase apps at
  once**, signing into each with the same credentials.
- Which only works because the account migration is an `auth:export`/`import`
  **copy**. The accounts must exist in both projects, not be moved from one to
  the other.

Decided with the analyst 2026-08-27:

| Question | Decision |
|---|---|
| Legacy installs still writing to the old project | Dashboard reads BOTH until they are retired |
| Dashboard email/password accounts | Migrate (copy) into `apaisuite` |
| `aurorbuddy.firebaseapp.com` | Keep it — hosting stays put, only the data moves |

Hosting staying put is free: hosting and auth are independent, so the dashboard
can be served from the old project while authenticating against both.

---

## What moves

Seven collections, of which the suite writes four:

| Collection | Written by | Notes |
|---|---|---|
| `tool_events` | suite + legacy | Two schema shapes; rules accept both |
| `tool_scans` | suite + legacy | |
| `tool_workflows` | suite | Workflow lifecycle |
| `tool_metric_events` | suite | Per-action telemetry — the firehose |
| `tool_metrics` | legacy | Per-analyst rolling summary |
| `tool_cache_stores` / `tool_cache_scans` | legacy | Caches; arguably need not move |
| `users` | dashboard | Sign-up metadata, keyed by auth uid |

`users` is keyed by **auth uid**. Those uids only stay valid if the auth
migration preserves them — `auth:import` does, provided the export is used
unmodified.

---

## Already done (committed, inert)

1. `modules/aurorbuddy/backend/firestore.rules` — copied verbatim from the live
   standalone project so behaviour is identical on day one, with a header
   explaining the named-database choice and the auth consequence above.
2. `modules/aurorbuddy/backend/firestore.indexes.json` — likewise.
3. `firebase.json` — third `firestore` target for the `aurorbuddy` database,
   beside `(default)` and `digitalmetrics`.
4. `modules/aurorbuddy/lib/firestore_config.js` — now carries `databaseId`, and
   all seven previously-hardcoded `databases/(default)` paths across
   `firestore.js` and `usage_metrics.js` derive from it. **Value unchanged**, so
   this is a no-op until deliberately flipped.

---

## Before you start: the two CLIs are different accounts

Checked 2026-08-27 on this machine, and it will stop step 1 dead:

```
firebase  -> sinaptick@gmail.com              (owns apaisuite + aurorbuddy)
gcloud    -> ses008s.s01458.us@wal-mart.com   (PERMISSION_DENIED on apaisuite)
```

Every `gcloud` step below needs the owning account:

```bash
gcloud auth login sinaptick@gmail.com
gcloud config set project apaisuite
```

The `firebase` steps are already fine. Worth checking rather than assuming — the
failure is a flat PERMISSION_DENIED that reads like a missing IAM role rather
than the wrong identity.

## Runbook

Ordering matters: create, deploy rules, copy data, migrate auth, teach the
dashboard to read both, and only THEN point the extension at the new home.
Flipping the extension early would write into an empty database while the
dashboard still reads the old one.

### 1. Create the database

```bash
gcloud firestore databases create --database=aurorbuddy --location=nam5 --project=apaisuite
```

Match `--location` to the existing `digitalmetrics` database, or cross-database
reads pay a latency penalty for no reason. Check with:

```bash
gcloud firestore databases describe --database=digitalmetrics --project=apaisuite --format="value(locationId)"
```

### 2. Deploy the rules BEFORE any data exists

A named database with no rules denies everything, which is the safe direction,
but deploy first so the import lands somewhere already governed.

```bash
cd unified-extension-suite && firebase deploy --only firestore:rules --project apaisuite
```

### 3. Copy the data

Firestore has no direct project-to-project copy; it goes via a GCS bucket.

```bash
gcloud firestore export gs://<bucket>/aurorbuddy-$(date +%Y%m%d) --project=aurorbuddy
gcloud firestore import gs://<bucket>/aurorbuddy-<date> --database=aurorbuddy --project=apaisuite
```

The bucket must be in the same location as both databases. Import is additive
and **overwrites documents with matching ids** — safe on an empty target,
destructive if re-run after the new database has taken live writes.

### 4. Copy the auth accounts

```bash
firebase auth:export users.json --project aurorbuddy
firebase auth:import users.json --project apaisuite \
  --hash-algo=SCRYPT --hash-key=<key> --salt-separator=<sep> --rounds=<n> --mem-cost=<n>
```

The hash parameters come from the **source** project. Get them — and the filled-in
import command — with:

```bash
node scripts/auth-hash-config.mjs          # redacted
node scripts/auth-hash-config.mjs --reveal # runnable
```

This section used to say the parameters "are only in the console". **That was
wrong**, and it mattered: the console is unreachable from a Walmart machine
(the corp proxy blocks Google web sign-in for personal accounts) so it read as
a hard blocker on a step that is actually two commands. The Identity Toolkit
admin config resource returns them as `signIn.hashConfig`, from the same
endpoint `scripts/enable-anon-auth.mjs` already calls. Confirmed live against
`aurorbuddy` on 2026-08-29: `SCRYPT`, rounds 8, memoryCost 14.

The console path (Authentication → Users → ⋮ → Password hash parameters) still
works and remains the fallback if the API ever stops returning `hashConfig`.

Without the parameters the accounts import but every password fails, and there
is no way to tell until someone tries to log in. Verify with a real login
before announcing anything.

`users.json` contains password hashes — write it somewhere disposable rather
than into a repo, keep it out of git, and delete it once the import succeeds.
The signer key is a secret too: do not paste a revealed one into a ticket or a
chat.

### 5. Dashboard reads both

`~/shanesmith/dashboard/app.js`: a second `initializeApp` for `apaisuite` with
its own `getAuth`/`getFirestore`, signing in with the same credentials, and
listeners over both. Rows carry `analystSource` already, so merged results stay
attributable. De-duplicate on document id — the copy means the same historical
row exists in both until legacy is retired.

### 6. Flip the extension

One line in `firestore_config.js`:

```js
projectId:  "apaisuite",
databaseId: "aurorbuddy",
webApiKey:  "<apaisuite web api key>",
```

Then release. Suite installs write to the new database from that version on;
older suite installs keep writing to the old project until they update, which is
the same situation as the legacy extension and is already handled by step 5.

### 7. Retire

Once no writes have landed in the old project for a full cycle: drop the second
Firebase app from the dashboard, and make the old project read-only rather than
deleting it — the historical data is the point of the migration, not a casualty
of it.

---

## What could bite

- **Import overwrites by document id.** Step 3 is safe exactly once. Re-running
  it after go-live silently reverts anything written since.
- **Password hash parameters are per-project and not in the export.** Miss them
  and the failure is invisible until a user cannot log in.
- **`users/{uid}` docs are keyed by auth uid.** They only line up if the auth
  import preserved uids; verify one before trusting the set.
- **Two Firebase apps means two sign-ins.** If either fails the dashboard is
  half-blind, and the natural failure mode is showing fewer rows rather than an
  error. It should say which sources are connected.
- **Cost.** Cross-project reads are still reads; the dashboard's per-action
  firehose query is the expensive one, and it now runs twice.
