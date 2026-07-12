#!/usr/bin/env bash
# scripts/release.sh
#
# One-command release for APAISuite.
#
# What it does:
#   1. Bumps the version in manifest.json
#   2. Stages and zips the extension source
#   3. Renders updates/version manifest and the qrcallbox.com landing page
#   4. Copies artifacts to ../QRCallBox/public/extension/ ready for deploy
#
# This script does NOT upload to the Chrome Web Store — that's a manual step
# in the CWS Developer Dashboard (see docs/RELEASING.md). The same ZIP this
# script produces is the one you upload there.
#
# Usage:
#   ./scripts/release.sh patch          # 0.4.0 -> 0.4.1
#   ./scripts/release.sh minor          # 0.4.0 -> 0.5.0
#   ./scripts/release.sh major          # 0.4.0 -> 1.0.0
#   ./scripts/release.sh 0.4.2          # explicit version
#   ./scripts/release.sh --dry-run      # show what would happen
#
# Environment overrides:
#   BASE_URL             default: https://qrcallbox.com/extension (no trailing slash)
#   CWS_LISTING_URL      default: empty until first CWS publish; set after
#                         publish so the landing page's primary CTA points right.
#   QRCALLBOX_DIR        default: ../../QRCallBox
#   RELEASE_NOTES        default: empty (one short line; will be JSON-escaped)

set -euo pipefail

# ─── Config (override via env) ──────────────────────────────────────
BASE_URL="${BASE_URL:-https://qrcallbox.com/extension}"
CWS_LISTING_URL="${CWS_LISTING_URL:-}"
QRCALLBOX_DIR="${QRCALLBOX_DIR:-}"
RELEASE_NOTES="${RELEASE_NOTES:-}"

# ─── Paths ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APAISUITE_ROOT="$(cd -- "$EXT_ROOT/.." && pwd)"

if [[ -z "$QRCALLBOX_DIR" ]]; then
  if [[ -d "$APAISUITE_ROOT/../QRCallBox" ]]; then
    QRCALLBOX_DIR="$(cd -- "$APAISUITE_ROOT/../QRCallBox" && pwd)"
  else
    echo "error: QRCALLBOX_DIR not set and ../../QRCallBox doesn't exist." >&2
    exit 1
  fi
fi

MANIFEST="$EXT_ROOT/manifest.json"
TEMPLATES_DIR="$SCRIPT_DIR/templates"
TARGET_DIR="$QRCALLBOX_DIR/public/extension"

# Use mktemp so concurrent runs don't collide. Cleanup on exit.
STAGE_ROOT="$(mktemp -d -t apaisuite-release.XXXXXX)"
trap 'rm -rf "$STAGE_ROOT"' EXIT
STAGED_EXT="$STAGE_ROOT/ext"

# ─── Arg parsing ────────────────────────────────────────────────────
DRY_RUN=0
BUMP=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) BUMP="$arg" ;;
  esac
done

if [[ -z "$BUMP" ]]; then
  echo "error: pass one of: patch | minor | major | <x.y.z>" >&2
  echo "       use --help to see full usage" >&2
  exit 64
fi

# ─── Sanity checks ──────────────────────────────────────────────────
[[ -f "$MANIFEST" ]]      || { echo "error: manifest.json not found at $MANIFEST" >&2; exit 1; }
[[ -d "$TEMPLATES_DIR" ]] || { echo "error: templates dir missing: $TEMPLATES_DIR" >&2; exit 1; }
[[ -d "$QRCALLBOX_DIR" ]] || { echo "error: QRCallBox dir not found: $QRCALLBOX_DIR" >&2; exit 1; }
command -v node >/dev/null || { echo "error: node not on PATH" >&2; exit 1; }

# Node ZIP tooling. We bundle this in scripts/ because the systems we ship
# from (Walmart corp laptops, Windows PowerShell 5.1) lack a usable native
# `zip` and Compress-Archive writes broken backslash-pathed archives.
if [[ ! -d "$SCRIPT_DIR/node_modules/adm-zip" ]]; then
  echo "error: scripts/node_modules/adm-zip not installed." >&2
  echo "       run once: (cd scripts && npm install)" >&2
  exit 1
fi

# ─── Version compute ────────────────────────────────────────────────
# Node on Windows can't read Git-Bash-style /c/... paths, so convert to a form
# Node understands ("C:/..."). cygpath is absent on real *nix, so fall back.
to_node_path() {
  if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
MANIFEST_NODE="$(to_node_path "$MANIFEST")"

CURRENT_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST_NODE','utf8')).version)")"

bump_version() {
  local cur="$1" mode="$2" MAJ MIN PAT
  IFS='.' read -r MAJ MIN PAT <<<"$cur"
  case "$mode" in
    patch) PAT=$((PAT + 1)) ;;
    minor) MIN=$((MIN + 1)); PAT=0 ;;
    major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
    *)
      if [[ "$mode" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$mode"; return
      else
        echo "error: bad bump arg '$mode' (use patch|minor|major or x.y.z)" >&2
        exit 64
      fi
      ;;
  esac
  echo "$MAJ.$MIN.$PAT"
}

NEW_VERSION="$(bump_version "$CURRENT_VERSION" "$BUMP")"
PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

ZIP_NAME="apaisuite-${NEW_VERSION}.zip"
ZIP_URL="${BASE_URL}/${ZIP_NAME}"
LANDING_URL="${BASE_URL}/"

echo "──────────────────────────────────────────────"
echo " APAISuite release"
echo "──────────────────────────────────────────────"
echo " current version : $CURRENT_VERSION"
echo " new version     : $NEW_VERSION"
echo " base url        : $BASE_URL"
echo " cws listing url : ${CWS_LISTING_URL:-(unset — set via env after first CWS publish)}"
echo " target dir      : $TARGET_DIR"
echo " release notes   : ${RELEASE_NOTES:-(NONE — version.json.releaseNotes will be empty; landing page reads release history from releases.json instead)}"
echo " dry run         : $DRY_RUN"
echo "──────────────────────────────────────────────"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] stopping before any side effects."
  exit 0
fi

# ─── 1. Bump manifest version ───────────────────────────────────────
echo "[1/5] bumping manifest.json to $NEW_VERSION ..."
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$MANIFEST_NODE','utf8'));
  m.version = '$NEW_VERSION';
  fs.writeFileSync('$MANIFEST_NODE', JSON.stringify(m, null, 2) + '\n');
"

# ─── 2. Stage extension files ───────────────────────────────────────
echo "[2/5] staging extension files ..."
mkdir -p "$STAGED_EXT"

# Things that don't belong in the published extension:
#   scripts/   — release tooling itself
#   docs/      — developer docs
#   dev/       — debug helpers; node_modules underneath holds ~40 MB of
#                puppeteer-core that has no business shipping to users
#   .git, .claude, .playwright-mcp, .vscode — dotfiles cp -r * skips anyway,
#                but listed defensively in case someone runs this from a
#                staging tree where they were already copied
#   node_modules/ at any depth — nested ones are easy to miss otherwise
#   *.pem, *.zip, *.crx, .DS_Store — build/signing artifacts
cp -r "$EXT_ROOT"/* "$STAGED_EXT/"
rm -rf "$STAGED_EXT/scripts" \
       "$STAGED_EXT/docs" \
       "$STAGED_EXT/dev" \
       "$STAGED_EXT/.git" \
       "$STAGED_EXT/.claude" \
       "$STAGED_EXT/.playwright-mcp" \
       "$STAGED_EXT/.vscode" \
       "$STAGED_EXT/node_modules"
# Defensive: strip any nested node_modules left behind by a future feature
# (this is what blew up v0.7.1 to 10 MB — dev/node_modules survived because
# only the top-level rm pattern was applied).
find "$STAGED_EXT" -type d -name node_modules -prune -exec rm -rf {} +
find "$STAGED_EXT" \( -name '*.pem' -o -name '*.crx' -o -name '*.zip' -o -name '.DS_Store' \) -delete

# ─── 3. Zip source ──────────────────────────────────────────────────
echo "[3/5] zipping source -> $ZIP_NAME ..."
ZIP_OUT="$STAGE_ROOT/$ZIP_NAME"
TOP="apaisuite-${NEW_VERSION}"
mkdir -p "$STAGE_ROOT/zipstage/$TOP"
cp -r "$STAGED_EXT"/* "$STAGE_ROOT/zipstage/$TOP/"

node "$(to_node_path "$SCRIPT_DIR/zip-dir.mjs")" \
     "$(to_node_path "$STAGE_ROOT/zipstage/$TOP")" \
     "$(to_node_path "$ZIP_OUT")"

[[ -s "$ZIP_OUT" ]] || { echo "error: zip output is empty/missing: $ZIP_OUT" >&2; exit 1; }

# ─── 4. Render templates ────────────────────────────────────────────
echo "[4/5] rendering version.json + index.html ..."

# Minimal JSON-string escape for embedding into the templates.
escape_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}
RELEASE_NOTES_ESC="$(escape_json "$RELEASE_NOTES")"

render() {
  local tpl="$1" out="$2"
  sed \
    -e "s|{{VERSION}}|$NEW_VERSION|g" \
    -e "s|{{PUBLISHED_AT}}|$PUBLISHED_AT|g" \
    -e "s|{{ZIP_URL}}|$ZIP_URL|g" \
    -e "s|{{LANDING_URL}}|$LANDING_URL|g" \
    -e "s|{{CWS_LISTING_URL}}|$CWS_LISTING_URL|g" \
    -e "s|{{RELEASE_NOTES}}|$RELEASE_NOTES_ESC|g" \
    "$tpl" > "$out"
}

render "$TEMPLATES_DIR/version.json.template" "$STAGE_ROOT/version.json"
render "$TEMPLATES_DIR/index.html.template"   "$STAGE_ROOT/index.html"

# ─── 5. Copy artifacts to QRCallBox public/extension/ ───────────────
echo "[5/5] copying artifacts to $TARGET_DIR ..."
mkdir -p "$TARGET_DIR"

cp "$ZIP_OUT"                   "$TARGET_DIR/$ZIP_NAME"
cp "$ZIP_OUT"                   "$TARGET_DIR/apaisuite-latest.zip"
cp "$STAGE_ROOT/version.json"   "$TARGET_DIR/version.json"
cp "$STAGE_ROOT/index.html"     "$TARGET_DIR/index.html"

# ─── Done ───────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────────"
echo " v$NEW_VERSION staged."
echo "──────────────────────────────────────────────"
echo ""
echo " Next steps:"
echo ""
echo " 1) Deploy QRCallBox hosting:"
echo "      cd \"$QRCALLBOX_DIR\" && npm run build && firebase deploy --only hosting"
echo ""
echo " 2) Upload the same ZIP to the Chrome Web Store dashboard:"
echo "      File: $TARGET_DIR/$ZIP_NAME"
echo "      Dashboard: https://chrome.google.com/webstore/devconsole"
echo "      (See docs/RELEASING.md for first-time CWS setup.)"
echo ""
echo " 3) Verify the deploy:"
echo "      curl --ssl-no-revoke $BASE_URL/version.json"
echo ""
