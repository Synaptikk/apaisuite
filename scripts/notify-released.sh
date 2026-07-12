#!/usr/bin/env bash
# scripts/notify-released.sh
#
# Run AFTER `firebase deploy --only hosting` finishes publishing a new
# version of QRCallBox/public/extension/. Tells the QRCallBox cloud
# function to web-push every registered extension installation so they
# see the "update available" pill in seconds instead of waiting for the
# 6-hour polling alarm.
#
# Usage:
#   ./scripts/notify-released.sh                      # reads version from QRCallBox/public/extension/version.json
#   ./scripts/notify-released.sh 0.8.2                # explicit version override
#
# Auth: needs EXTENSION_NOTIFY_SECRET in your env. Set it once:
#   firebase functions:secrets:access EXTENSION_NOTIFY_SECRET --project=qrwebaccdb
# and export the value, or add to ~/.bashrc:
#   export EXTENSION_NOTIFY_SECRET="<value-from-the-command-above>"

set -u

ENDPOINT="${EXTENSION_NOTIFY_ENDPOINT:-https://qrcallbox.com/api/extension/notify-update}"

if [[ -z "${EXTENSION_NOTIFY_SECRET:-}" ]]; then
  # Try to fetch it from Firebase if the user is logged in. Non-interactive
  # path — silent on failure so we don't hang the release flow.
  if command -v firebase >/dev/null 2>&1; then
    SECRET="$(firebase functions:secrets:access EXTENSION_NOTIFY_SECRET --project=qrwebaccdb 2>/dev/null || true)"
    if [[ -n "$SECRET" ]]; then
      EXTENSION_NOTIFY_SECRET="$SECRET"
    fi
  fi
fi

if [[ -z "${EXTENSION_NOTIFY_SECRET:-}" ]]; then
  echo "error: EXTENSION_NOTIFY_SECRET unset and 'firebase functions:secrets:access' didn't return a value." >&2
  echo "       Fetch it manually:" >&2
  echo "         firebase functions:secrets:access EXTENSION_NOTIFY_SECRET --project=qrwebaccdb" >&2
  echo "       then export and re-run." >&2
  exit 1
fi

# Determine version: arg, else parse from version.json.
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VJSON_REL_PATH="../../QRCallBox/public/extension/version.json"
  HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  VJSON="$HERE/$VJSON_REL_PATH"
  if [[ ! -f "$VJSON" ]]; then
    echo "error: $VJSON not found. Pass version explicitly: ./notify-released.sh 0.8.2" >&2
    exit 1
  fi
  VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$VJSON','utf8')).version)")"
fi

echo "→ Broadcasting push for v$VERSION to $ENDPOINT ..."

# --ssl-no-revoke for the corp proxy's broken CRL endpoint.
RESP="$(curl --ssl-no-revoke -s -w "\n__HTTP__%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $EXTENSION_NOTIFY_SECRET" \
  -d "{\"version\":\"$VERSION\"}" 2>&1)" || true

CODE="$(echo "$RESP" | tail -n1 | sed 's/^__HTTP__//')"
BODY="$(echo "$RESP" | sed '$d')"

echo "  HTTP $CODE"
echo "  $BODY"

if [[ "$CODE" != "200" ]]; then
  echo "error: broadcast failed." >&2
  exit 1
fi
echo "✓ Push broadcast complete."
