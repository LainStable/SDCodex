#!/usr/bin/env bash
# SDCodex container entrypoint: ensure runtime dirs, then run the backend.
set -euo pipefail

mkdir -p /data/db /app/plugins /app/db /models /downloads /plugins /rembg_output

# Honour PUID/PGID from .env so created files have correct ownership.
if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ]; then
  # Ensure group exists with the requested GID
  if ! getent group "${PGID}" >/dev/null 2>&1; then
    groupadd -g "${PGID}" sdcodex 2>/dev/null || true
  fi
  # Ensure user exists with the requested UID and group
  if ! id -u "${PUID}" >/dev/null 2>&1; then
    useradd -u "${PUID}" -g "${PGID}" -o -m -s /bin/bash sdcodex 2>/dev/null || true
  fi
  usermod -u "${PUID}" -g "${PGID}" sdcodex 2>/dev/null || true
  # Fix ownership for persistent directories
  chown -R sdcodex:sdcodex /app /data /models /downloads /plugins /rembg_output 2>/dev/null || true
fi

cd /app

# Honour an explicit command. The blue-green swap helper is launched as
# `sdcodex-swap` with `python -m sdcodex.swap_helper`; the old script dropped
# that command and booted a second app instead, so the swap never ran.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Run as the correct user when PUID/PGID is configured
if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ] && id -u sdcodex >/dev/null 2>&1; then
  exec su - sdcodex -c 'python backend/run.py'
else
  exec python backend/run.py
fi
