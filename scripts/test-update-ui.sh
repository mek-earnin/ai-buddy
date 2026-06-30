#!/usr/bin/env bash
#
# Exercise the in-app update UI in dev WITHOUT publishing a real release.
#
# Spins up a local HTTP server serving a fake `latest.json` that advertises a
# higher version, then runs `tauri dev` with the updater endpoint overridden to
# that server (via `--config`, so the committed tauri.conf.json is untouched).
#
# What this verifies:
#   - The version shows in the brand header (e.g. "v2.1.1").
#   - The "Update to vX.Y.Z" pill appears (fetch_update_status → available).
#   - Clicking the pill opens the confirm dialog (install_update wiring).
#
# What it does NOT verify (needs a real installed .app — see notes below):
#   - The actual download + signature verify + replace + relaunch. With the
#     mock signature the download step fails verification and shows the error
#     dialog — that's expected and still proves the dialog/error path.
#
# Usage:
#   ./scripts/test-update-ui.sh                 # fake version 9.9.9, port 8787
#   FAKE_VERSION=3.0.0 PORT=9000 ./scripts/test-update-ui.sh
#
# After dev starts, trigger the window (global shortcut, default
# Ctrl+Shift+Space, or tray → Show AI Buddy) and look at the header.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
FAKE_VERSION="${FAKE_VERSION:-9.9.9}"
MOCK_DIR="$ROOT/.update-mock"
ENDPOINT="http://localhost:$PORT/latest.json"

command -v python3 >/dev/null || { echo "ERROR: python3 required for the mock server" >&2; exit 1; }

# --- Build the mock manifest + a dummy artifact -----------------------------
mkdir -p "$MOCK_DIR"
cat > "$MOCK_DIR/latest.json" <<EOF
{
  "version": "$FAKE_VERSION",
  "notes": "Mock update for UI testing — not a real release.",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "MOCK_SIGNATURE_NOT_VALID",
      "url": "http://localhost:$PORT/AI.Buddy.app.tar.gz"
    }
  }
}
EOF
# Placeholder artifact so the download step has a target (signature verify will
# still reject it — expected for a UI-only test).
echo "not a real artifact" > "$MOCK_DIR/AI.Buddy.app.tar.gz"

# --- Serve it ----------------------------------------------------------------
( cd "$MOCK_DIR" && exec python3 -m http.server "$PORT" >/dev/null 2>&1 ) &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Give the server a moment, then sanity-check it.
sleep 1
if ! curl -fsS "$ENDPOINT" >/dev/null; then
  echo "ERROR: mock server not reachable at $ENDPOINT" >&2
  exit 1
fi

echo "──────────────────────────────────────────────────────────────"
echo " Mock update endpoint : $ENDPOINT"
echo " Advertised version   : $FAKE_VERSION  (installed is lower → pill should show)"
echo " Open the window      : global shortcut (default Ctrl+Shift+Space)"
echo "                        or tray icon → Show AI Buddy"
echo " Expect               : header shows version + 'Update to v$FAKE_VERSION' pill"
echo " Click the pill        : confirm dialog → (mock) install fails verify = OK"
echo " Stop                 : Ctrl+C (restores everything automatically)"
echo "──────────────────────────────────────────────────────────────"

# --- Run dev with the endpoint overridden (committed config untouched) -------
npm run tauri:dev -- --config "{\"plugins\":{\"updater\":{\"endpoints\":[\"$ENDPOINT\"]}}}"
