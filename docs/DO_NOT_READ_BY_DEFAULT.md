# Do Not Read By Default

Files and folders that future AI sessions should **skip unless explicitly
asked about the topic**. Reading them will pollute context with outdated or
no-longer-actionable information.

**Last reviewed:** 2026-06-02.

For the full status of every doc, see [`DOC_STATUS.md`](DOC_STATUS.md). This
file is the short skip-list with one-line rationales.

---

## Stale tracker docs (never read by default)

### `FEATURE_PARITY.md`
Frozen 2026-05-23 before any feature shipped. Every feature shows
`not-started` — six modules are live in production. The tracker was never
maintained.

### `SOURCE_MAPPING.md`
Frozen 2026-05-31. Covers only 3 of 6 modules. Status fields like
`copied / adapted / verified / shared` were never updated after the initial
migration. `git log` is authoritative for "which file came from where".

### `PERMISSIONS_MATRIX.md`
Frozen 2026-05-23. Lists 10 permissions and 11 host patterns. Current
`manifest.json` has 14 permissions and 23 hosts. The doc never tracked the
permissions added when claimsdisposition, digitallocks, workvivo,
claimsbuddy, the updater, and Web Push landed. `manifest.json` is the
source of truth.

---

## Superseded / historical (read only on a specific trigger)

### `EXTENSION_SUITE_AUDIT.md`
Pre-migration audit of the three original donor extensions. Useful only if
you need to understand *why* a particular donor pattern was kept or
abandoned. Don't read it to learn how the suite works today.

### `MIGRATION_PLAN.md`
Phases 1–5 are shipped; Phase 6 (polish + retirement) is partial. The only
section that survived as a live document is "Importing a new extension" —
that has been folded into `MODULE_CONTRACT.md::13. Recipe`. Read this only
to understand the migration narrative.

### `ARCHITECTURE.md` — selective skip
Read only when designing platform-level changes. Two specific traps:
- §2 (the module contract) describes `service: { handlers: () => import("./service.js") }`
  with dynamic import — this was **abandoned** because MV3 SWs cannot use
  dynamic `import()`. Use `MODULE_CONTRACT.md` for the current contract.
- §11 ("Extension points for the future") describes a `dev/build-manifest.js`
  pipeline that doesn't exist in the release flow — top-level `manifest.json`
  is currently maintained by hand.

### `RELEASING.md` — selective skip
Read only when cutting a release. Heed: every paragraph about the Chrome
Web Store describes a path that was deferred. Today's release channel is
qrcallbox.com only. Skip the "Chrome Web Store developer account" and "Upload
the same ZIP to the Chrome Web Store dashboard" sections. The qrcallbox.com
deploy + the in-extension nag pill description are still accurate.

---

## Probe scripts (read findings, not scripts)

`dev/probe-*.mjs` and the captured JSON/PNG artifacts. Read
`dev/HOOPS_FINDINGS.md` and `dev/DIRECTORY_FINDINGS.md` for the synthesized
results. The raw `dev/*.json` / `dev/*.png` files are evidence dumps that
won't surprise you with anything not already in the summary docs.

---

## Donor source extensions (NEVER edited)

These live on disk and are read-only references. Never modify, port fixes
from suite back. Read only when comparing a suite module to its donor.

- `C:\Users\ses008s.s01458\Desktop\ClosingList\extension\`
- `C:\Users\ses008s.s01458\Documents\puppy_workspace\aurorbuddy\extension\`
- `C:\Users\ses008s.s01458\Desktop\SparkFraud\extension\`

---

## Dependency manifests

- `**/node_modules/**` — never search. Use Glob's pattern exclusion.
- `scripts/node_modules/` (for `adm-zip`) and `dev/node_modules/` (for
  puppeteer and friends) are intentional and tiny — same rule.
- `package-lock.json` — read only if debugging an `npm install` issue.

---

## How to use this file

When you find a stale or confusing doc that's tripping up future AI sessions,
add it here with a one-line rationale. When a doc gets refreshed and
becomes useful again, remove the entry.

The shorter this file stays, the less work future sessions have to do
mentally filtering noise.
