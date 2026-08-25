# Digital Metrics — associate-name privacy

How the `digitalmetrics` module keeps associate names out of Firestore while
still showing them to every authorised user, in every store.

**Status:** mechanism implemented + tested; awaiting sign-off on §6.
**Last reviewed:** 2026-08-25
**Companion:** `LICENSE_INTAKE_PII_HANDLING.md` (same house style, stricter data)

---

## 1. Requirement

> Encrypt associate names such that users from different stores can all read
> the data the extension produces, but no names are stored on the database.

Two consequences fall straight out of that sentence:

- **Names must render in the UI.** You cannot staff a 5am pick shift against
  an opaque id. So this is *encryption*, not hashing — a one-way digest can
  never be shown back to the operator.
- **Every authorised user must be able to decrypt**, including users who have
  never seen the store the data came from. So the key cannot be per-user or
  per-store; it is one org-wide key shipped with the extension.

## 2. What actually goes on the wire

Every associate is written as a two-field pair, never a name:

```
{ t: "X7eMU-nJaWMENzsoqoDwQA",         // token  — deterministic, irreversible
  n: "qp3n…"                            // sealed — randomised ciphertext
}
```

| Field | Primitive | Deterministic? | Job |
|---|---|---|---|
| `t` | HMAC-SHA256(canonical name), 128 bits | yes | the **join key**. Map keys, lookups, cross-source joins. |
| `n` | AES-256-GCM, random 96-bit IV | no | the **display value**. Decrypted at render. Never a key. |

Splitting them is the design. One deterministic reversible field would be both
a key *and* a plaintext-equivalent; two fields means the thing used for lookups
can never be decrypted, and the thing that can be decrypted is useless for
lookups. Keys are derived from one master secret via HKDF with distinct `info`
labels, so the token key and the display key are cryptographically unrelated.

## 3. Threat model — read this before saying "encrypted"

The key ships inside a sideloaded extension. **Every install has a copy.** It
is not secret from anyone holding the extension and never will be.

**Protects against**
- a compromised or misconfigured Firestore
- anyone reading the database directly — console, REST, exports, backups
- associate names sitting at rest on Google infrastructure

**Does not protect against**
- a person who has the extension; they decrypt everything
- **traffic analysis.** Tokens are deterministic, so *equality* and *frequency*
  of associates leak: an observer can tell that the same unnamed person appears
  in week 12 and week 34, and who the busiest unnamed picker is. Accepted
  deliberately — no cross-week feature in this module works without it.

If the requirement ever becomes "the database operator must not learn the
shape of the roster either", this design is insufficient and the answer is
to stop storing per-associate rows centrally at all.

## 4. Canonicalisation — the part that actually breaks

`lib/names.js::canonical()` is **frozen**. A token is
`HMAC(canonical(name))`; if canonical() ever returns something different for a
name it previously handled, that associate's entire history orphans silently,
with no error and no migration short of decrypting and rewriting every doc.

It has to be aggressive because the two sources disagree by design — the
Tableau export emits `SMITH, JOHN A`, the scheduler emits
`John Smith - Cap 2 Assoc`. The donor app carries *six* separate reconciliation
scripts for exactly this reason.

Rules: strip a trailing job title after a **spaced** dash, NFKD-fold accents,
flip `LAST, FIRST`, uppercase, drop generational suffixes, reduce punctuation,
collapse whitespace.

Two decisions worth knowing:

- **The dash must be spaced.** An unspaced hyphen is part of a surname. An
  earlier draft stripped after any dash and turned `Smith-Jones, Amy` into
  `SMITH`. Regression-tested.
- **Middle initials are kept.** Dropping them would merge `<FIRST> K` into
  `<FIRST> M` — two different people who share a first name, whom the donor's
  mapping table separates by hand. The cost is that `SMITH, JOHN A` and `John Smith` do not converge on
  their own; that pairing is an alias-table job.

To change the rules: add a *new* version, keep the old, tokenise under both
during a dual-read window.

## 5. The alias table is PII and is never committed

Nicknames and truncations (a badge nickname → a full name) cannot be derived. They
need a lookup table — and that table maps a real name to a real name, so
committing it puts the roster in git, which is exactly what this module exists
to prevent.

**The donor does this today:** `functions/index.js` hardcodes ~70 real
associate names in `NAME_MAPPINGS`, plus three in `TEAM_LEAD_NAMES`, committed
and pushed.

Here it lives in `chrome.storage.local` under `digitalmetrics.aliases`:
device-local, never `chrome.storage.sync`, never in the repo, never sent to
Firestore. The SW rehydrates it on each wake.

## 6. Open decisions — need sign-off

1. **Key provisioning.** `lib/crypto_config.js` currently holds a placeholder.
   A committed real key is a public key. `crypto.js::configureKey()` exists so
   `scripts/release.sh` can inject it at package time; that build step is not
   written yet.
2. **Firestore rules cutover.** See §8 — this is the live-security item.
3. **Key rotation story.** Rotating re-encrypts display names but must not
   change token derivation. No rotation tooling exists yet.

## 7. Enforcement — why this isn't just a convention

The donor has 33 Firestore call sites, each doing `.set(wholeObjectWithNames)`.
Encrypting at 33 call sites means leaking at whichever one gets forgotten.

Instead:

1. `lib/firestore.js` is the only file that may build a Firestore request.
2. Every encoder in `lib/codec.js` **rebuilds** its document from a field
   allowlist. Unknown fields are dropped, not copied — leaking a name requires
   deliberately adding it to an allowlist, not merely forgetting to strip it.
3. `assertNoPlaintextNames()` runs on every write as a backstop.

A useful side effect: the allowlist drops `Associate ID`, a durable personal
identifier the donor stores but never reads (verified — zero references in
9,305 lines), along with three other unused columns.

## 8. The live-security item

`~/Digital Metrics/firestore.rules` is, today, in production:

```
match /{document=**} { allow read, write: if true; }
```

Every associate name in `digitalmetrics-fe0f3` is currently readable and
writable by anyone who knows the project id. Encrypting new writes does not
change that for data already there.

The module signs in anonymously (`lib/firestore.js::idToken`) specifically so
the rules can be tightened to `request.auth != null` without a module rewrite.
**The standalone web app has no auth at all** — no `signIn`, no
`onAuthStateChanged`, nothing — so tightening the rules breaks it the moment
it deploys. Ordering options in §6.2.

## 9. Audit checklist (run before any release)

- [ ] `node --test modules/digitalmetrics/lib/tests/privacy.test.mjs` green
- [ ] `crypto_config.js` does not contain the placeholder secret
- [ ] `grep -rn "\.set(\|fetch(" modules/digitalmetrics/ --include=*.js` — every
      Firestore call is inside `lib/firestore.js`
- [ ] `chrome.storage.sync.get(null)` after a full session shows no roster data
- [ ] Network panel during a save: request bodies contain no readable names
- [ ] `node modules/digitalmetrics/tools/audit_names.mjs` exits 0 — no real
      associate name appears anywhere under `modules/digitalmetrics/`. This
      caught two genuine leaks during the port (donor names copied into
      comments and test fixtures), which is why it is a script and not a
      checklist item. Exit 2 means it could not read the donor and therefore
      did not actually check.
