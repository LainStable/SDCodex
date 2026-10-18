#!/usr/bin/env bash
# SDCodex container entrypoint: ensure runtime dirs, then run the backend.
set -euo pipefail

mkdir -p /data/db /app/plugins /app/db
cd /app

# Honour an explicit command. The blue-green swap helper is launched as
# `sdcodex-swap` with `python -m sdcodex.swap_helper`; the old script dropped
# that command and booted a second app instead, so the swap never ran.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Fresh backend DB gets bootstrapped through the UI (first user = admin).
exec python backend/run.py
