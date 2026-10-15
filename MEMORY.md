# SDCodex — Project Memory

_Persisted 2026-10-15. Session-local knowledge worth carrying forward. Supplemented by
live code when in doubt — this is a snapshot, not a substitute for reading the files._

## Repo layout (important)
- `backend/sdcodex/` — Flask app: `rebuilder.py` (self-rebuild), `updater.py` (git core/plugin
  updates), `api_v1.py` (REST endpoints), `models.py`, `scanner.py`.
- `app/src/` — React frontend. `components/chrome.tsx` (Sidebar, Topbar, UserMenu radial fan),
  `views/Core.tsx` (Plugin Hub + Updates panel), `views/Settings.tsx`, `App.tsx`, `index.css`.
- `docker-compose.yml` + `docker-compose.override.yml` — override is written at runtime by
  Settings → Plugins; core file stays pristine.
- `Plugin-Hub/plugins.json` — hub catalog; `core.version` is the source of truth for update
  badges. Bump it on every core push.
- `VERSION` — core version file. Bump on release.

## Self-rebuild (`backend/sdcodex/rebuilder.py`)
- Blue-green: builds image, starts a port-less sibling `sdcodex-new`, waits for health via
  `exec`, stops old self to free the host port, recreates sibling with the port mapping.
- `_interp` resolves nested compose defaults innermost-first (`${SDCODEX_PORT:-${PORT:-5000}}`).
  A single-pass outer-first regex left a stray `}` and broke every rebuild port mapping —
  fixed to loop to a fixed point.
- `_old_host_port()` reads the old container's live `HostPort` for 5000/tcp and uses it as
  fallback/override, so the replacement always publishes the same host port regardless of
  how the port was configured.
- Sibling uses `restart: no` mid-rebuild so it can't autostart on reboot mid-swap.
- Final container rejoins the old container's networks and is health-checked before the old
  one is removed.

## Core update flow
- `POST /updates/core` → `updater.update_core()` → `git pull --ff-only <remote> <branch>`.
- Returns 409 on failure. `is_clean()` uses `--untracked-files=no` so untracked files don't
  block updates; dirty files are named in the 409 message.
- A successful no-op pull ("Already up to date") no longer sets the rebuild-required flag.
- `POST /system/rebuild` kicks the rebuild in a background thread; frontend polls
  `/system/rebuild/log` + `/health` and reloads once the version changes.

## Sidebar update badge (`app/src/components/chrome.tsx`)
- Clicking the badge always navigates to Settings → Plugins (the Updates panel), never fires
  an update directly. The old `onUpdateCore` prop and the silent `updateCore` helper in
  `App.tsx` were removed.
- Plugin Hub Updates panel has Check now / Update core / Rebuild now with visible status.

## Radial fan menu hover (`app/src/index.css`)
- On hover: icon button gets a 2px light-blue outline (`#4cd7f6`, the design-system
  `secondary` color) + tinted fill + glow; label gets a light-blue bordered box with
  near-black bg and light-blue text. `:focus-within` included for keyboard nav.

## Git state
- `main` branch, remote `upstream` (https://github.com/LainStable/SDCodex.git).
- Latest commit `e0abdd5`, VERSION `1.0.34`.
- `Plugin-Hub/plugins.json` core.version bumped to `1.0.34`; live plugin versions already
  matched the catalog (gallery 2.0.0, gallery-dl 0.1.5, rembg 1.8.0, comfy-caption 2.4.0).

## Pending / known issues
- **Memory backend not working.** Installed `openmemory@0.0.1` is a broken stub — it POSTs
  to `api.openmemory.dev`, which now redirects to a Mem0 marketing page. Add returns
  "success" but list/search return nothing. The real backend is CaviraOSS/OpenMemory
  (Docker or `cd backend && npm run dev`), not installed. `openmemory.jsonc` points at
  `localhost:8080` which isn't running. Needs user action.
- **Transcripts not located.** Searched `~/.claude/session-data`, `~/.gemini/antigravity`,
  `~/.config/opencode/session-data`, `~/.config/opencode/sessions` — all empty or stale.
  Only `session-ses_f5ae.md` in repo root exists, and it's an ECC-install transcript, not
  SDCodex work. User was going to locate them.

## Conventions
- Conventional commits (`fix:`, `feat:`, `perf:`, `fix(compose):`).
- `docker-compose.override.yml`, `.env`, `plugin-requirements.txt`, `plugins/*`, `db/`,
  `models/`, `downloads/`, `tasks/`, `config/` are git-ignored runtime material.
- `testing/` is a sibling repo, never pushed into core.