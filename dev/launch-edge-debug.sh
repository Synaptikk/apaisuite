#!/usr/bin/env bash
# dev/launch-edge-debug.sh
#
# Closes any running Edge, then relaunches it with --remote-debugging-port=9222
# using your normal Edge profile (so all your extensions + sign-ins are intact).
# After this, run `npm run debug:aurorbuddy` from this dev/ folder.

set -u

EDGE_EXE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
USER_DATA_DIR="$LOCALAPPDATA/Microsoft/Edge/User Data"
PORT="${EDGE_DEBUG_PORT:-9222}"

if [[ ! -x "$EDGE_EXE" ]]; then
  echo "✗ Edge not found at: $EDGE_EXE" >&2
  exit 1
fi

# Edge must be fully closed before --remote-debugging-port takes effect on the
# real profile. If any msedge.exe is alive on this profile, the flag is ignored.
echo "→ closing any running Edge…"
taskkill //F //IM msedge.exe //T >/dev/null 2>&1 || true
sleep 1

echo "→ launching Edge with --remote-debugging-port=$PORT"
echo "  profile dir: $USER_DATA_DIR"
"$EDGE_EXE" --remote-debugging-port="$PORT" --user-data-dir="$USER_DATA_DIR" >/dev/null 2>&1 &
disown || true
sleep 2

# Probe the CDP endpoint
if curl --ssl-no-revoke -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/json/version" | grep -q 200; then
  echo "✓ Edge is up with CDP on http://localhost:$PORT"
  echo "  next: cd dev && npm run debug:aurorbuddy"
else
  echo "✗ CDP endpoint not responding on port $PORT after 2s." >&2
  echo "  Likely cause: Walmart group policy blocks remote-debugging." >&2
  echo "  Confirm by visiting http://localhost:$PORT/json/version in Edge itself." >&2
  exit 1
fi
