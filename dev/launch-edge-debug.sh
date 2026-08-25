#!/usr/bin/env bash
# dev/launch-edge-debug.sh
#
# Launch Edge with a CDP debugging port so the probe scripts in dev/ can drive
# a real, SSO-authenticated browser.
#
# ── Why a DEDICATED profile and not your normal one ────────────────────────
# Chromium 136+ (Edge 151 here) refuses to open a remote-debugging port when
# --user-data-dir points at the DEFAULT profile directory. It is a deliberate
# hardening measure against cookie theft, it fails SILENTLY — Edge starts
# normally and simply never listens — and there is no flag to opt out.
#
# So the probes get their own persistent profile. You complete corporate SSO in
# it ONCE, by hand, and every future probe run reuses that session. This is the
# same arrangement Desktop\ScheduleCalendar uses for the Workforce Planning
# portal, and for the same reason.
#
# Consequences worth knowing:
#   · It runs ALONGSIDE your normal Edge. Nothing is closed, nothing is shared.
#   · It has no bookmarks, extensions or history — that is not a bug.
#   · Its cookies persist between runs, so SSO is a one-time cost.
#   · Deleting the directory below resets it; you would sign in again.
#
# Usage:
#   ./dev/launch-edge-debug.sh          # port 9222
#   ./dev/launch-edge-debug.sh 9333     # some other port
#
# First run: sign in to the corporate SSO prompt in the window that opens.
# Then:
#   node dev/probe-tableau-view.mjs OnlineGrocery StoreFulfillmentScorecard AssociatePerformance

set -euo pipefail

PORT="${1:-9222}"
# Deliberately OUTSIDE the repo so it is never staged, zipped or committed —
# it holds live session cookies.
PROFILE_DIR="${APAISUITE_EDGE_PROFILE:-$HOME/.apaisuite-edge-debug}"

EDGE=""
for candidate in \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Microsoft/Edge/Application/msedge.exe"
do
  [[ -x "$candidate" ]] && { EDGE="$candidate"; break; }
done
[[ -n "$EDGE" ]] || { echo "error: msedge.exe not found in either Program Files location." >&2; exit 1; }

# Already up from a previous run? Reuse it rather than spawning a second one.
if node -e "fetch('http://localhost:$PORT/json/version').then(r=>r.json()).then(d=>{console.log(d.Browser);process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "CDP already live at http://localhost:$PORT — reusing it."
  exit 0
fi

mkdir -p "$PROFILE_DIR"
echo "Debug profile : $PROFILE_DIR"
echo "Debug port    : $PORT"
echo "Your normal Edge is left alone."
echo

"$EDGE" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$(cygpath -w "$PROFILE_DIR" 2>/dev/null || echo "$PROFILE_DIR")" \
  --no-first-run \
  --no-default-browser-check \
  >/dev/null 2>&1 &
disown || true

for _ in $(seq 1 25); do
  sleep 1
  if node -e "fetch('http://localhost:$PORT/json/version').then(r=>r.json()).then(d=>{console.log('  '+d.Browser);process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
    echo
    echo "CDP is live at http://localhost:$PORT"
    echo
    echo "If this is a first run, sign in to corporate SSO in the new window"
    echo "before running any probe. The session is reused after that."
    exit 0
  fi
done

echo >&2
echo "error: Edge started but nothing is answering on port $PORT after 25s." >&2
echo "       If Edge is managed, remote debugging may be disabled by policy" >&2
echo "       (check edge://policy for RemoteDebuggingAllowed)." >&2
exit 1
