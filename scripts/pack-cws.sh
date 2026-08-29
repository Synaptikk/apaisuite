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

# Node on Windows cannot read Git-Bash-style /c/... paths — it resolves them
# relative to the drive and looks for C:\c\Users\... This script used to hand
# node its paths raw and died on ENOENT at the first call, so pack-cws.sh could
# not build anything on a Windows box at all. release.sh has always had this
# helper; the packer never got a copy. Every node invocation below goes
# through it.
to_node_path() {
  if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$(to_node_path "$EXT_ROOT/manifest.json")','utf8')).version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
EXT="$STAGE/apaisuite"
mkdir -p "$EXT"

echo "[1/7] staging v$VERSION ..."
cp -r "$EXT_ROOT"/* "$EXT/"
# Same exclusions as release.sh — see its section 2 for the rationale.
rm -rf "$EXT/scripts" "$EXT/docs" "$EXT/dev" "$EXT/.git" "$EXT/.claude" \
       "$EXT/.playwright-mcp" "$EXT/.vscode" "$EXT/node_modules"
find "$EXT" -type d -name node_modules -prune -exec rm -rf {} +
# Same trap as node_modules: the rm above only matches the tree ROOT, so a
# nested dot-directory survives it — modules/assocpurchases/.playwright-mcp
# carried 137 debug console logs into every package built here.
find "$EXT" -type d -name '.playwright-mcp' -prune -exec rm -rf {} +
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

echo "[2/7] stripping modules excluded from the store build ..."
node "$(to_node_path "$SCRIPT_DIR/strip-modules.mjs")" "$(to_node_path "$EXT")" "${STRIP_MODULES[@]}"

# ── API permissions dropped from the store build ────────────────────────────
#
# `debugger` is the most heavily scrutinised permission a package can ask for,
# and exactly ONE module wants it: sparkfraud attaches CDP to spoof
# visibilityState so background SSO isn't throttled, and to click the SSO
# button on the one host where Walmart's Edge MDM policy makes
# chrome.scripting.executeScript hang forever.
#
# That workaround exists for managed corporate machines, which run the
# self-hosted build. Paying for it with the riskiest permission in a store
# submission is a bad trade, so the store build goes without.
#
# sparkfraud/service.js guards every use behind HAS_DEBUGGER and degrades to a
# foregrounded tab. Do NOT drop a permission here without checking the module
# survives its absence — an unguarded top-level chrome.debugger listener throws
# during service-worker registration and takes the WHOLE SUITE down, which is
# what happened to be one refactor away when this was written.
DROP_PERMISSIONS=(debugger)

echo "[3/7] dropping API permissions not shipped to the store ..."
node -e '
  const fs = require("fs");
  const [manifestPath, ...drop] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const before = m.permissions ?? [];
  const missing = drop.filter((p) => !before.includes(p));
  if (missing.length) {
    // A permission that is not there did not get dropped — it got renamed or
    // removed upstream, and this list is now lying about what it protects.
    console.error(`  error: not in manifest.permissions: ${missing.join(", ")}`);
    process.exit(1);
  }
  m.permissions = before.filter((p) => !drop.includes(p));
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  console.log(`  dropped ${drop.join(", ")} (${before.length} -> ${m.permissions.length} permissions)`);
' "$(to_node_path "$EXT/manifest.json")" "${DROP_PERMISSIONS[@]}"

# The self-updater polls qrcallbox.com and downloads a new build's ZIP —
# distribution outside the Web Store, which policy forbids, and pointless for a
# store install that Chrome updates on its own. Swapped for no-op stubs with
# identical exports rather than deleted, because app.js and the service worker
# import them unconditionally. The unpacked/self-hosted build keeps the real
# thing: there, the self-updater is the ONLY way users get new versions.
# Web Push goes the same way, for the same reason: its only payload type is
# "extension-update", whose notification links to the off-store download page.
# See scripts/stubs/push.js.
echo "[4/7] replacing the self-updater with store stubs ..."
for f in updater updater_ui push; do
  [ -f "$EXT/shared/$f.js" ] || { echo "  error: shared/$f.js missing from staged tree" >&2; exit 1; }
  cp "$SCRIPT_DIR/stubs/$f.js" "$EXT/shared/$f.js"
  echo "  stubbed shared/$f.js"
done

echo "[5/7] validating manifest for store upload ..."
node "$(to_node_path "$SCRIPT_DIR/check-cws.mjs")" manifest "$(to_node_path "$EXT")"

echo "[6/7] zipping (manifest at archive root) ..."
mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/apaisuite-${VERSION}-cws.zip"
rm -f "$ZIP"
node "$(to_node_path "$SCRIPT_DIR/zip-dir.mjs")" "$(to_node_path "$EXT")" "$(to_node_path "$ZIP")" --root

echo "[7/7] verifying archive layout ..."
( cd "$SCRIPT_DIR" && node "$(to_node_path "$SCRIPT_DIR/check-cws.mjs")" zip "$(to_node_path "$ZIP")" )

echo ""
echo "  upload this:  $ZIP"
