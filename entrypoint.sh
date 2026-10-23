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

  # Docker socket access for in-app self-update. The app drops to sdcodex,
  # while the mounted socket is root:docker 0660 — without this the rebuild
  # dies with `PermissionError(13, 'Permission denied')` on /var/run/docker.sock.
  DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
  if [ -S "$DOCKER_SOCK" ]; then
    sock_gid="${DOCKER_GID:-$(stat -c '%g' "$DOCKER_SOCK" 2>/dev/null || true)}"
    if [ -n "${sock_gid:-}" ]; then
      [ -n "$(getent group "$sock_gid" || true)" ] || \
        { groupadd -g "$sock_gid" docker >/dev/null 2>&1 || true; }
      sock_group="$(getent group "$sock_gid" | cut -d: -f1 || true)"
      if [ -n "${sock_group:-}" ]; then
        usermod -aG "$sock_group" sdcodex >/dev/null 2>&1 || true
        if id -nG sdcodex 2>/dev/null | tr ' ' '\n' | grep -qx "$sock_group"; then
          echo "docker socket: sdcodex in group ${sock_group} (gid ${sock_gid})"
        else
          echo "docker socket: could not add sdcodex to group ${sock_group} (gid ${sock_gid}) — self-update disabled" >&2
        fi
      fi
    fi
  fi

  # The swap helper runs as root and appends to the update log, so hand these
  # files back to the app user or later updates cannot report progress.
  for f in /app/.rebuild.log /app/.rebuild-required; do
    [ -e "$f" ] && ! owned "$f" && chown "${OWNER}" "$f" 2>/dev/null || true
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
