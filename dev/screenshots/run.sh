#!/usr/bin/env bash
# Regenerate the Chrome Web Store screenshots. See README.md.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$ROOT/docs/store-assets}"
PORT="${PORT:-8731}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME — set CHROME=" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true' EXIT

# The harness pages reference the real CSS and the real renderers by relative
# path, so assemble a tree that mirrors the repo's layout.
cp "$HERE"/*.html "$HERE"/_shell.js "$WORK/"
cp -R "$ROOT/styles" "$WORK/styles"
mkdir -p "$WORK/vizpick/lib" "$WORK/metricshot/lib"
cp "$ROOT/modules/vizpick/lib/charts.js"          "$WORK/vizpick/lib/"
cp "$ROOT/modules/vizpick/styles.css"             "$WORK/vizpick/"
cp "$ROOT/modules/metricshot/lib/render_card.js"  "$WORK/metricshot/lib/"
cp "$ROOT/modules/metricshot/styles.css"          "$WORK/metricshot/"

( cd "$WORK" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
SRV=$!
sleep 1

mkdir -p "$OUT"
for page in "$WORK"/*.html; do
  name="$(basename "$page" .html)"
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1280,800 \
    --virtual-time-budget=4000 \
    --screenshot="$OUT/$name.png" "http://127.0.0.1:$PORT/$name.html" 2>&1 \
    | grep "bytes written" || { echo "failed: $name" >&2; exit 1; }
done

echo "screenshots in $OUT"
