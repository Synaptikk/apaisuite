#!/usr/bin/env bash
# dev/dev-build.sh
#
# Produce a LOADABLE unpacked build of the suite for local testing.
#
# Why this exists: modules/digitalmetrics ships with a placeholder master key
# (lib/crypto_config.js), and lib/crypto.js::assertRealKey() refuses to derive
# from it — deliberately, so a build can never ship the publicly-known value.
# The consequence is that loading the working tree directly gives you a
# DigitalMetrics tab that throws on the first name it tries to tokenise.
#
# scripts/release.sh solves this for releases by injecting the key from Secret
# Manager into a staged copy (step 2b). This is the same trick for development:
# copy the tree, inject there, leave the working tree with its placeholder so
# the key can never be committed.
#
# The output path is STABLE (not mktemp) on purpose. An unpacked extension's id
# is derived from its path when the manifest carries no "key" field — which
# this one doesn't — so a fixed path means a fixed id, which means
# chrome.storage survives a rebuild. It also means this build gets a DIFFERENT
# id from the installed release, so the two coexist without sharing state.
#
# Usage:
#   ./dev/dev-build.sh                 # build to the default path
#   ./dev/dev-build.sh /some/other/dir # build somewhere else
#
# Then: edge://extensions (or chrome://extensions) → Developer mode →
#       "Load unpacked" → pick the printed path.
#
# Rebuild after any source change: the browser caches the module graph per id,
# so "Reload" on an unchanged path is not enough for SW code — re-run this,
# then hit Reload.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUT="${1:-$(cd -- "$EXT_ROOT/../.." && pwd)/APAISuite-dev/unified-extension-suite}"

echo "[1/3] copying $EXT_ROOT -> $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# Everything except VCS, dependencies and build leftovers. dev/ and lib/tests/
# are KEPT — this is a development build and they cost nothing at runtime.
tar -C "$EXT_ROOT" \
    --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='*/node_modules' \
    --exclude='*.zip' \
    --exclude='*.pem' \
    --exclude='*.crx' \
    -cf - . | tar -C "$OUT" -xf -

# ─── Inject the digitalmetrics master key ───────────────────────────
#
# Same source and same 44-char check as scripts/release.sh step 2b, so a dev
# build tokenises identically to a release build. That matters: a different key
# here would write rows that the released extension cannot join or decrypt.
DM_CRYPTO_CONFIG="$OUT/modules/digitalmetrics/lib/crypto_config.js"
if [[ -f "$DM_CRYPTO_CONFIG" ]]; then
  echo "[2/3] injecting digitalmetrics master key from Secret Manager ..."
  DM_KEY="$(firebase functions:secrets:access DIGITALMETRICS_MASTER_KEY --project apaisuite 2>/dev/null | tr -d '\r\n')"

  if [[ -z "$DM_KEY" ]]; then
    echo "error: could not read DIGITALMETRICS_MASTER_KEY from Secret Manager." >&2
    echo "       Check 'firebase login:list' and that the apaisuite project is reachable." >&2
    exit 1
  fi
  if [[ ${#DM_KEY} -ne 44 ]]; then
    echo "error: DIGITALMETRICS_MASTER_KEY is ${#DM_KEY} chars, expected 44 (32 bytes base64)." >&2
    exit 1
  fi

  # node, not sed: base64 contains / and +, which sed would eat as delimiters.
  # Test that the PATTERN matched, not that the output changed. Those are
  # different questions, and conflating them fails whenever the source already
  # holds the same key — which is exactly the case after
  # ./dev/inject-dev-key.sh has run against the working tree.
  node -e '
    const fs = require("fs");
    const [file, key] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    const RE = /export const MASTER_SECRET_B64 = "[^"]*";/;
    if (!RE.test(src)) {
      console.error("error: MASTER_SECRET_B64 assignment not found in " + file);
      process.exit(1);
    }
    fs.writeFileSync(file, src.replace(RE, "export const MASTER_SECRET_B64 = " + JSON.stringify(key) + ";"));
  ' "$DM_CRYPTO_CONFIG" "$DM_KEY" || exit 1

  if grep -q "REPLACE_ME" "$DM_CRYPTO_CONFIG"; then
    echo "error: placeholder still present after injection." >&2
    exit 1
  fi
  echo "      key injected (44 chars, value not logged)"
  unset DM_KEY
fi

# Guard against the reverse mistake: this build now holds a real key, so it
# must never become a git repo that someone pushes.
rm -rf "$OUT/.git"

echo "[3/3] done."
echo
echo "Load unpacked from:"
echo "  $(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
echo
echo "This build carries the REAL master key. Do not commit or zip it."
