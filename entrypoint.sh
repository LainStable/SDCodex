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
  usermod -u "${PUID}" -g "${PGID}" sdcodex >/dev/null 2>&1 || true

  # Fix ownership for persistent directories. A blind `chown -R` walked the
  # whole bind-mounted repo (node_modules, .venv, testing data, model dirs) on
  # every start, delaying the backend by minutes. Only touch a path when its
  # own owner is wrong, and never recurse into the big trees.
  OWNER="sdcodex:sdcodex"
  owned() { [ "$(stat -c '%u:%g' "$1" 2>/dev/null)" = "${PUID}:${PGID}" ]; }

  # Top-level only — repo, model and download trees can be huge.
  for p in /app /models /downloads; do
    [ -e "$p" ] && ! owned "$p" && chown "${OWNER}" "$p" 2>/dev/null || true
  done
  # Small app-owned dirs: recurse, but skip when already correct.
  for p in /data /app/plugins /app/db /plugins /rembg_output; do
    [ -e "$p" ] && ! owned "$p" && chown -R "${OWNER}" "$p" 2>/dev/null || true
  done
fi

cd /app

# Honour an explicit command. The blue-green swap helper is launched as
# `sdcodex-swap` with `python -m sdcodex.swap_helper`; the old script dropped
# that command and booted a second app instead, so the swap never ran.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Run as the correct user when PUID/PGID is configured. Use a non-login shell
# (`su` without `-`): a login shell chdirs to /home/sdcodex, which broke the
# relative `backend/run.py` path. cd /app explicitly and keep HOME sane.
if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ] && id -u sdcodex >/dev/null 2>&1; then
  exec su sdcodex -s /bin/bash -c 'cd /app && exec python backend/run.py'
else
  exec python backend/run.py
fi
