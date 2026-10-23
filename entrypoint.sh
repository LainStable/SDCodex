#!/usr/bin/env bash
# SDCodex container entrypoint: ensure runtime dirs, then run the backend.
set -euo pipefail

mkdir -p /data/db /app/plugins /app/db /models /downloads /plugins /rembg_output
echo "sdcodex: preparing runtime directories"

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

  # Fix ownership for the paths the core actually owns. A blind `chown -R`
  # walked bind-mounted trees (media, models, LLM weights — ~2 TB on some
  # installs) on every start, keeping the container unhealthy for minutes.
  OWNER="sdcodex:sdcodex"
  owned() { [ "$(stat -c '%u:%g' "$1" 2>/dev/null)" = "${PUID}:${PGID}" ]; }

  # Non-recursive: the app only needs to be able to create files in these
  # roots. Never walk into them — plugin volumes may point at huge libraries.
  for p in /app /data /models /downloads /plugins /rembg_output; do
    [ -e "$p" ] && ! owned "$p" && chown "${OWNER}" "$p" 2>/dev/null || true
  done
  # Recursive, strictly for the small state directories the core writes:
  # sqlite DB, settings/paths, task state, plugin checkouts.
  for p in /data/db /data/config /data/tasks /app/db /app/plugins; do
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
echo "sdcodex: starting backend"
if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ] && id -u sdcodex >/dev/null 2>&1; then
  exec su sdcodex -s /bin/bash -c 'cd /app && exec python backend/run.py'
else
  exec python backend/run.py
fi
