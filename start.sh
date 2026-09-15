#!/usr/bin/env bash
# SDCodex full-stack launcher: backend (Flask :5000) + frontend (Vite :5173).
# Usage: ./start.sh [--no-install] [--backend-only] [--frontend-only]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
APP="$ROOT/app"
VENV="$BACKEND/.venv"
BACKEND_PID=""
VITE_PID=""

cleanup() {
  for pid in $VITE_PID $BACKEND_PID $SLEEP_PID; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup INT TERM EXIT

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }
}

need python3
need node
need npm

DO_INSTALL=1
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --no-install) DO_INSTALL=0 ;;
    --backend-only) ONLY="backend" ;;
    --frontend-only) ONLY="frontend" ;;
    *) echo "Unknown flag: $arg (see header)" >&2; exit 1 ;;
  esac
done

# --- Backend ---------------------------------------------------------------
# Reap strays from earlier runs (same project backend only).
pkill -f "$BACKEND/.venv/bin/python run.py" 2>/dev/null || true
if [ "$ONLY" != "frontend" ]; then
  if [ ! -x "$VENV/bin/python" ]; then
    echo "Creating backend venv..."
    python3 -m venv "$VENV"
  fi
  if [ "$DO_INSTALL" = "1" ]; then
    echo "Installing backend requirements..."
    "$VENV/bin/pip" install -q -r "$BACKEND/requirements.txt"
  fi
  echo "Starting backend on :5000..."
  # exec: the forked subshell becomes python itself, so $! is the real PID
  # (without exec the pidfile would hold a dead intermediate shell).
  (cd "$BACKEND" && exec env HOST="${SDCODEX_HOST:-0.0.0.0}" PORT=5000 "$VENV/bin/python" run.py >"$BACKEND/backend.log" 2>&1 &
   echo $! >"$BACKEND/backend.pid")
  BACKEND_PID="$(cat "$BACKEND/backend.pid")"
  for _ in $(seq 1 30); do
    if curl -sf http://127.0.0.1:5000/api/health >/dev/null 2>&1; then
      echo "Backend healthy."
      break
    fi
    sleep 1
    if [ "$_ " = "30 " ]; then echo "Backend failed to start — see $BACKEND/backend.log" >&2; exit 1; fi
  done
fi

# --- Frontend --------------------------------------------------------------
if [ "$ONLY" != "backend" ]; then
  if [ "$DO_INSTALL" = "1" ] && [ ! -d "$APP/node_modules" ]; then
    echo "Installing frontend dependencies..."
    (cd "$APP" && npm install)
  fi
  echo "Starting frontend (Vite)..."
  echo "  UI:      http://127.0.0.1:5173"
  echo "  Backend: http://127.0.0.1:5000/api/health"
  echo "Press Ctrl+C to stop both."
  # Run the vite binary directly (not `npm run dev`): npm swallows SIGINT
  # and orphans vite on Ctrl+C. Backgrounded under this script's trap so
  # both processes die together. exec keeps the pidfile accurate (see above).
  (cd "$APP" && exec ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 &
   echo $! >"$APP/.vite.pid")
  VITE_PID="$(cat "$APP/.vite.pid")"
fi

# Park here until Ctrl+C; the trap takes down backend + vite together.
# (Plain `wait` on reparented grandchildren returns instantly, so sleep instead.)
sleep infinity &
SLEEP_PID=$!
wait "$SLEEP_PID" 2>/dev/null || true
