# Digital Metrics — backend schema

The Firestore layout the `digitalmetrics` module writes.

**Status: LIVE as of 2026-08-25.** Project `apaisuite`, database
`digitalmetrics` (a named database, not `(default)` — that one holds
suite-wide telemetry under its own rules). Rules deployed and verified
against the live project: a signed-in read of this database is permitted,
and a write aimed at the suite database's collections is refused, so the
two really are isolated rather than isolated-on-paper.

The database starts **empty**. Data in the legacy standalone project
(`digitalmetrics-fe0f3`) was deliberately not migrated.

**Companion:** `PRIVACY.md` (why names look like this),
`modules/digitalmetrics/backend/` (rules + indexes),
`unified-extension-suite/backend/README.md` (project shape, deploy).

---

## 1. Provisioning checklist

1. ✅ **Project + databases.** `apaisuite` on Blaze, with `(default)` and
   `digitalmetrics` in `nam5`. Anonymous auth enabled.
   *Named (non-`(default)`) databases require billing — Spark gives you
   `(default)` only, which is what forced the Blaze decision.*
2. ✅ **`projectId` + `apiKey` + `databaseId`** set in `lib/config.js`, still
   the only place any of them appears.
3. ⬜ **Generate a real 32-byte key** and inject it via
   `crypto.configureKey()` at package time. Do **not** commit it to
   `lib/crypto_config.js`; a committed key is a public key, and this repo is
   public. `crypto.js::assertRealKey()` now refuses to derive from the
   placeholder, so skipping this fails loudly at the first name encryption
   instead of silently giving every install the same known key.
4. ✅ **Rules deployed** from `unified-extension-suite/` (where `firebase.json`
   lives — the CLI rejects rules paths outside its directory):
   `firebase deploy --only firestore --project apaisuite`
5. ⬜ **`digitalmetrics.writerEnabled`** — leave unset (writes default on) only
   once step 3 is done.

Reminder for the console-only steps: `apaisuite` is owned by a personal Google
account, and the Walmart network blocks that account from
`console.firebase.google.com`. The Cloud Console
(`console.cloud.google.com/customer-identity`) was reachable and is where
Anonymous auth actually got enabled; otherwise a non-corp network is needed.
Everything else here is CLI-reachable, which is unaffected.
5. Leave `digitalmetrics.writerEnabled` unset (writes default on) only once
   steps 2–4 are done.

## 2. Collection map

```
metrics/
├── stores            { list: ["1458", …] }
└── classifications   { data: { <token>: { c, n } } }

stores/{store}/
├── weeks/{YYYY-MM-DD}              ← Saturday that starts the week
├── schedules/{YYYY-MM-DD}
├── dailyAssignments/{YYYY-MM-DD}
└── suggestions/{YYYY-MM-DD}
```

Unchanged from the legacy layout on purpose — the migration is a re-encoding of
document *contents*, not a reshaping of paths, which keeps it reversible and
keeps the diff reviewable.

## 3. The associate pair

Every associate, everywhere, is two fields and never a name:

| Field | Value | Deterministic | Use |
|---|---|---|---|
| `t` | HMAC-SHA256(canonical name), 128-bit, base64url | yes | join key, map key |
| `n` | AES-256-GCM(name), random IV, base64url | no | display only |

`suggestions` carries `t` alone — it is machine-generated and rendered against
a roster that has already been decoded, so it never needs the ciphertext.

## 4. Document shapes

Every document additionally carries `schemaVersion: 2` and
`writerSource: "suite"`. The rules reject anything below version 2, which is
what stops a stale client writing plaintext names back into a clean database.

### `metrics/stores`
```ts
{ list: string[], schemaVersion: 2, writerSource: "suite" }
```

### `metrics/classifications`
```ts
{ data: { [token: string]: { c: "Digital"|"Exceptions"|"Fashion"|"Store Help",
                             n: string } } }
```

### `stores/{store}/weeks/{weekStart}`
```ts
{
  rawData: Array<{
    t: string, n: string,
    "Pick Date": string, "Store #": string, "Min. First Scan": string,
    "FTP Expected": number, "FTP Actual": number,
    "Pick Rate": number, "Pick Hours": number,
    "Picked As Req Qty": number, "Substitution Qty": number, "Nil Pick Qty": number,
    "Exception Qty Req to Pick": number, "Exception Picked As Req Qty": number,
    "Exception Substitution Qty": number, "Exception Nil Pick Qty": number,
  }>,
  fileName: string | null,
  uploadDate: string,     // ISO
  store: string,
  weekStart: string,      // YYYY-MM-DD, a Saturday
}
```

The column list is an **allowlist**, not documentation — `lib/codec.js` rebuilds
each row from it, so anything not named here is dropped rather than stored.
Four legacy columns are deliberately absent:

| Dropped | Why |
|---|---|
| `Associate ID` | A durable personal identifier. The app has never read it — zero references in the donor's 9,305 lines. |
| `Max. Last Scan` | Never read. |
| `FTPR` | Derived from `FTP Actual / FTP Expected`; storing it invites drift. |
| `Ovrd Qty` | Never read. |

### `stores/{store}/schedules/{date}`
```ts
{ associates: Array<{ t, n, shiftStart, shiftEnd, startSlot, endSlot }>,
  store: string, importedAt: string }
```

### `stores/{store}/dailyAssignments/{date}`
```ts
{ associates: Array<{ t, n, slots: { [slotIdx: string]: string },
                      status: "tardy"|"absent"|null, shiftStart, shiftEnd }>,
  date: string, day: "SAT"|…, updatedAt: string, store: string,
  finalized: boolean, finalizedAt: string | null }
```

`finalized` is enforced in rules: a finalised day cannot have its roster edited
until it is unfinalised, and no assignment document can be deleted.

### `stores/{store}/suggestions/{date}`
```ts
{ suggestions: { [token: string]: { [slotIdx: string]: { task, confidence } } },
  generatedAt: string, dayOfWeek: string, associateCount: number }
```

## 5. Query consequences of encryption

Worth stating plainly, because it constrains every future feature:

- **You cannot query by associate.** Tokens live inside array elements, which
  Firestore cannot index. Every per-associate filter, sort, search and
  autocomplete happens client-side after decryption.
- **You cannot prefix-search names.** Ciphertext has no useful ordering. The
  Associates tab's fuzzy autocomplete works on the decoded in-memory roster.
- **Whole documents are fetched, then filtered.** Fine at the current scale (a
  week document is one store's rows), but it means per-store data volume, not
  total row count, is the thing to watch.

If per-associate server-side querying is ever needed, the answer is a separate
token-keyed index collection — not decrypting anything.

## 6. Cloud Functions

The legacy project's four functions (`generateSuggestions`, `filterSchedule`,
`backfillSuggestions`, `filterExistingSchedules`) do not port as-is:

- They key on plaintext names and carry a hardcoded name table
  (`NAME_MAPPINGS`, `TEAM_LEAD_NAMES`) — roster PII committed to git.
- Under this schema the server sees only tokens, which is the point.

Two viable paths, to decide when the project exists:

1. **Client-side generation** (preferred). Suggestion generation is not
   expensive and the client already holds the decrypted roster. Removes the
   server's need to know anything about people at all.
2. **Token-only functions.** Rewrite them to operate purely on `t` values,
   with the alias/name table deleted rather than ported.

## 7. Migration from the legacy project

Not started; the target does not exist yet. When it does, the shape is the one
already proven for AurorBuddy in `BACKEND_MIGRATION_PLAN.md`: deploy rules and
indexes, dual-write with the `writerSource` discriminator, flip reads, sunset
the legacy writer, archive.

Two things a migration does **not** fix, and which need a separate decision:

- Plaintext names already in the legacy project, in its git history, in
  `functions/index.js`, in `import_historical_data.js`, and in
  `historical/*.xlsx`.
- The legacy project's open rules, which stay open until it is retired.
