#!/usr/bin/env bash
# dev/inject-dev-key.sh
#
# Put the real digitalmetrics master key into the WORKING TREE, so the suite
# can be loaded unpacked straight from this directory instead of from a
# dev-build copy.
#
# ── Read this before running ───────────────────────────────────────────────
# modules/digitalmetrics/lib/crypto_config.js is TRACKED, and this repo's
# origin is public (github.com/Synaptikk/apaisuite). Writing a real key into a
# tracked file is exactly what scripts/release.sh goes out of its way to avoid
# — it injects into a staged COPY so the key can never be committed.
#
# So this script does two things, and the second is not optional:
#   1. writes the key from Secret Manager into the working tree
#   2. marks the file --skip-worktree, so git stops reporting and staging the
#      local modification
#
# skip-worktree is a guard, not a guarantee. It does NOT protect you from
# `git add -f`, from `git stash`, from a rebase that touches the file, or from
# anyone who clones your machine's disk. If you would rather not have a live
# key inside a git working tree at all, use ./dev/dev-build.sh instead and load
# the extension from the build directory — that is the safer default.
#
# Undo:
#   ./dev/inject-dev-key.sh --revert
#
# Usage:
#   ./dev/inject-dev-key.sh
#   ./dev/inject-dev-key.sh --revert

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CFG_REL="modules/digitalmetrics/lib/crypto_config.js"
CFG="$EXT_ROOT/$CFG_REL"

cd "$EXT_ROOT"

if [[ "${1:-}" == "--revert" ]]; then
  echo "Restoring the committed placeholder ..."
  git update-index --no-skip-worktree "$CFG_REL" 2>/dev/null || true
  git checkout -- "$CFG_REL"
  grep -q "REPLACE_ME" "$CFG" && echo "✓ placeholder restored, file tracked again."
  exit 0
fi

[[ -f "$CFG" ]] || { echo "error: $CFG_REL not found." >&2; exit 1; }

# Refuse if the file is already staged — injecting under a staged change is how
# a key ends up in a commit nobody meant to make.
if ! git diff --cached --quiet -- "$CFG_REL" 2>/dev/null; then
  echo "error: $CFG_REL has STAGED changes. Unstage them first." >&2
  exit 1
fi

echo "Fetching DIGITALMETRICS_MASTER_KEY from Secret Manager ..."
DM_KEY="$(firebase functions:secrets:access DIGITALMETRICS_MASTER_KEY --project apaisuite 2>/dev/null | tr -d '\r\n')"

if [[ -z "$DM_KEY" ]]; then
  echo "error: could not read the secret. Check 'firebase login:list'." >&2
  exit 1
fi
if [[ ${#DM_KEY} -ne 44 ]]; then
  echo "error: key is ${#DM_KEY} chars, expected 44 (32 bytes base64)." >&2
  exit 1
fi

# node, not sed: base64 contains / and +.
# Match-test, not diff-test: re-running this when the key is already in place
# must be a no-op, not an error.
node -e '
  const fs = require("fs");
  const [file, key] = process.argv.slice(1);
  const src = fs.readFileSync(file, "utf8");
  const RE = /export const MASTER_SECRET_B64 = "[^"]*";/;
  if (!RE.test(src)) { console.error("error: MASTER_SECRET_B64 assignment not found"); process.exit(1); }
  fs.writeFileSync(file, src.replace(RE, "export const MASTER_SECRET_B64 = " + JSON.stringify(key) + ";"));
' "$CFG" "$DM_KEY"
unset DM_KEY

if grep -q "REPLACE_ME" "$CFG"; then
  echo "error: placeholder still present after injection." >&2
  exit 1
fi

# Hide the local modification from git.
git update-index --skip-worktree "$CFG_REL"

echo "✓ key injected (44 chars, value not logged)"
echo "✓ $CFG_REL marked --skip-worktree"
echo
if git status --porcelain -- "$CFG_REL" | grep -q .; then
  echo "!! WARNING: git still reports the file as modified. Do not commit." >&2
  exit 1
fi
echo "git reports the file as clean. Reload the extension to pick up the key."
echo "Undo with: ./dev/inject-dev-key.sh --revert"
