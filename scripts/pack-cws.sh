#!/usr/bin/env bash
#
# pack-cws.sh — build the upload ZIP for the Chrome Web Store.
#
# Deliberately NOT part of release.sh. That script builds the self-hosted
# artifacts (.zip/.kit/app/pkg.json, signing, landing page); the store wants
# exactly one thing: a ZIP with manifest.json at the archive ROOT, containing
# only files the extension actually runs.
#
# In particular the store rejects the self-hosted zip outright, because
# zip-dir.mjs nests every entry under apaisuite-<version>/ so that a manual
# download extracts to a single folder. Hence --root here.
#
# Usage:  scripts/pack-cws.sh [output-dir]      (default: /tmp)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-/tmp}"

command -v node >/dev/null || { echo "error: node not on PATH" >&2; exit 1; }
[ -d "$SCRIPT_DIR/node_modules/adm-zip" ] || { echo "error: run 'npm install' in scripts/ first" >&2; exit 1; }

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$EXT_ROOT/manifest.json','utf8')).version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
EXT="$STAGE/apaisuite"
mkdir -p "$EXT"

echo "[1/5] staging v$VERSION ..."
cp -r "$EXT_ROOT"/* "$EXT/"
# Same exclusions as release.sh — see its section 2 for the rationale.
rm -rf "$EXT/scripts" "$EXT/docs" "$EXT/dev" "$EXT/.git" "$EXT/.claude" \
       "$EXT/.playwright-mcp" "$EXT/.vscode" "$EXT/node_modules"
find "$EXT" -type d -name node_modules -prune -exec rm -rf {} +
find "$EXT" \( -name '*.pem' -o -name '*.crx' -o -name '*.zip' -o -name '.DS_Store' \) -delete
# Loose capture dumps at the repo root are dev scratch, not shipped code.
find "$EXT" -maxdepth 1 -name 'digitallocks-*.json' -delete
# Unit tests ship nothing useful to a user and are ~1% of the package.
find "$EXT" -type d -name tests -prune -exec rm -rf {} +
find "$EXT" \( -name '*.test.mjs' -o -name '*.test.js' \) -delete

# Modules kept in git but excluded from the store build, with the host
# permissions only they needed. assocpurchases is commented out of
# _registry.js — its content script still injected into sf-reports-ui and
# nothing consumed the result, so it was pure attack surface in the package.
STRIP_MODULES=(
  "assocpurchases:https://sf-reports-ui.walmart.com/*,https://sf-reports-api.walmart.com/*"
)

echo "[2/5] stripping modules excluded from the store build ..."
node "$SCRIPT_DIR/strip-modules.mjs" "$EXT" "${STRIP_MODULES[@]}"

echo "[3/5] validating manifest for store upload ..."
node "$SCRIPT_DIR/check-cws.mjs" manifest "$EXT"

echo "[4/5] zipping (manifest at archive root) ..."
mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/apaisuite-${VERSION}-cws.zip"
rm -f "$ZIP"
node "$SCRIPT_DIR/zip-dir.mjs" "$EXT" "$ZIP" --root

echo "[5/5] verifying archive layout ..."
( cd "$SCRIPT_DIR" && node "$SCRIPT_DIR/check-cws.mjs" zip "$ZIP" )

echo ""
echo "  upload this:  $ZIP"
