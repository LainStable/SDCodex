#!/usr/bin/env bash
# SDCodex container entrypoint: ensure runtime dirs, then run the backend.
set -euo pipefail

mkdir -p /data/db /app/plugins /app/db
cd /app

# Fresh backend DB gets bootstrapped through the UI (first user = admin).
exec python backend/run.py
