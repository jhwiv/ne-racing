#!/usr/bin/env bash
# Pre-ship gate. Runs the QA harness against the *local* working tree.
# Exits non-zero on any failure, blocking the push.
#
# Usage:
#   scripts/preship.sh                  # serve local index.html, run L1-L4
#   scripts/preship.sh --live           # run against railbirdai.com (post-push)
#   scripts/preship.sh --update-snaps   # refresh visual baselines
#
# Required: scripts/qa/node_modules installed (`cd scripts/qa && npm install`)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QA_DIR="$REPO_ROOT/scripts/qa"

if [ ! -d "$QA_DIR/node_modules" ]; then
  echo "==> Installing QA dependencies..."
  (cd "$QA_DIR" && npm install --silent)
fi

MODE="local"
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --live) MODE="live" ;;
    --update-snaps) export QA_UPDATE_BASELINE=1 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

if [ "$MODE" = "local" ]; then
  # Spin up a tiny static server on a free port. Python is universally available.
  PORT=$((8000 + RANDOM % 1000))
  echo "==> Starting local server on :$PORT"
  (cd "$REPO_ROOT" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null || true" EXIT
  sleep 1

  # Pull NE_APP_VERSION out of index.html so the version pin matches the
  # working-tree build, not whatever the user happens to have cached.
  VERSION=$(grep -oE "NE_APP_VERSION = '[^']*'" "$REPO_ROOT/index.html" | head -1 | sed "s/.*'\([^']*\)'.*/\1/")
  export QA_BASE_URL="http://127.0.0.1:$PORT/"
  export QA_VERSION="$VERSION"
  echo "==> Testing local build, NE_APP_VERSION=$VERSION"
else
  export QA_BASE_URL="https://railbirdai.com/"
  export QA_VERSION="${QA_VERSION:-}"
  echo "==> Testing live: $QA_BASE_URL"
fi

cd "$QA_DIR"
node run-all.js --preship
echo ""
echo "==> Pre-ship checks PASSED. Safe to push."
