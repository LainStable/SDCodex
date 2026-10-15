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
  `exec`, then a helper container performs the swap (see below).
- CRITICAL FLAW FOUND 2026-10-15: the rebuild ran in a thread inside the app
  container, so `me.stop()` killed its own process — all six logged rebuilds
  died at "stopping old self", the swap never ran, and a stale port-less
  `sdcodex-new` was left behind. Manual recovery from that state is where a
  default-port container slips in (the 20:17 run had resolved 5001 correctly).
- Fix: `backend/sdcodex/swap_helper.py` one-shot helper container
  (`python -m sdcodex.swap_helper`, auto-removed on exit). App thread hands it
  a JSON spec (old id, sibling, cname, resolved ports, binds, env, networks,
  restart, image); helper stops old self, recreates the sibling WITH ports,
  health-gates, renames old→`sdcodex-old` and final→live name, removes the old,
  clears `.rebuild-required`, logs `swap done`. Repo bind-mount is reused so
  the frontend rebuild-log stream keeps working through the swap.
- `_interp` resolves nested compose defaults innermost-first (`${SDCODEX_PORT:-${PORT:-5000}}`).
  A single-pass outer-first regex left a stray `}` and broke every rebuild port mapping —
  fixed to loop to a fixed point.
- `_old_host_port()` reads the old container's live `HostPort` for 5000/tcp and uses it as
  fallback/override, so the replacement always publishes the same host port regardless of
  how the port was configured.
- Port precedence (fixed 2026-10-15 — update used to recreate on 5000 ignoring a
  `.env` port change, because live always overwrote compose despite the comment
  claiming the opposite). `_resolve_ports()` now: (1) compose value, but ONLY on
  affirmative evidence of a post-start `.env` edit — file effective port differs
  from startup effective port AND dotenv mtime is newer than container
  `StartedAt`; (2) live binding (shell env, manual `docker run -p`,
  interpolation failure); (3) compose value when valid; (4) 5000. Verified
  with a 9-scenario simulation (post-start edit, stale-.env shell run,
  consistent custom, default, manual run, missing/garbage .env, missing
  self-lookup, port-preserving plugin rewrite).
- Sibling uses `restart: no` mid-rebuild so it can't autostart on reboot mid-swap.
- Final container rejoins the old container's networks and is health-checked before the old
  one is removed.

## Core update flow
- Single **Update** button (Settings → Plugins → Updates panel; the old
  separate Update-core / Rebuild-now buttons are gone as of 1.0.37):
  `POST /updates/core` (git pull, aborts cleanly on dirty tree) → then the
  rebuild flow (`POST /system/rebuild`, log stream, version-aware reload).
  The "Rebuild required" banner is status text only and points at Update.
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
## Build & run
- Full stack: `./start.sh` (backend Flask :5000 + Vite :5173)
- Flags: `--no-install`, `--backend-only`, `--frontend-only`
- Frontend only: `cd app && npm run dev`
- Backend only: `cd backend && python3 run.py`
- Build: `cd app && npm run build`  |  Lint: `cd app && npm run lint`

## Core update lifecycle
1. Push core code → bump `VERSION` + `Plugin-Hub/plugins.json` `core.version`
2. User: Settings → Plugins → "Check now" → `GET /updates/check`
   → `updater.check_core()` fetches hub `plugins.json`, compares `core.version` vs local `VERSION`
3. "Update core" → `POST /updates/core` → `git pull --ff-only <remote> <branch>`
   → `is_clean()` blocks if tracked files modified (untracked OK)
   → on success: `rebuilder.mark_rebuild("core update")`
4. "Rebuild now" → `POST /system/rebuild`
   → Docker: blue-green self-replace (build image, start `sdcodex-new`, health-check, swap names, remove old) via Docker SDK over `/var/run/docker.sock`
   → Bare metal: `os.execv` restart of `backend/run.py`
5. Frontend polls `/system/rebuild/log` + `/health`, reloads on version change

## Plugin Hub
- Catalog: `Plugin-Hub/plugins.json` (separate `SDCodex-Plugin-Hub` repo)
- Fetched at `HUB_URL = raw.githubusercontent.com/LainStable/SDCodex-Plugin-Hub/main/plugins.json`
- Used for: (a) update notifications for core + installed plugins, (b) populating the available-plugins list
- 4 official plugins, each in its own repo:
  - `gallery` (SDCodex-Gallery) v2.0.0
  - `gallery-dl` (SDCodex-GalleryDL) v0.1.5
  - `rembg` (SDCodex-RemBG) v1.8.0
  - `comfy-caption` (SDCodex-ComfyCaption) v2.4.0
- When a plugin is updated and pushed, its hub entry version is incremented → update notification
- Install: `POST /plugins/install` → clones repo into `plugins/`, merges `requirements.txt` → `plugin-requirements.txt`, applies volumes to `.env` + `docker-compose.override.yml`, marks rebuild
- Update: `POST /plugins/{id}/update` → `git pull --ff-only`
- Uninstall: `POST /plugins/{id}` → rm dir, strip volume config + requirements block
- Each plugin has `plugin.json` manifest: id, name, version, description, author, repository, icon, nav_items, settings, volumes, entrypoint
- GitHub token (`ghp_...`) saved to DB + `.env` for private repos
- Rebuild required after any plugin install/uninstall/volume change

## OldCode/ reference
- `OldCode/` is git-ignored (`OldCode/` in `.gitignore`) — never pushed
- Contains the old version of the program + old plugin implementations
- Use as reference / starting point for plugin rewrites
- **Plugin rewrites must keep the current site design** (DESIGN.md tokens, Obsidian Codex dark-first)
- Many plugins are currently broken due to changes not being pushed correctly

## Testing setup
- Pull + build the Docker image, run the app in a **separate directory**
- That test directory must **never be edited or modified**
- `testing/` is a sibling repo, never pushed into core

## Docker recovery (2026-10-15)
- `OldCode/docker recovery/sdcodex-updater_latest.tar` (image
  `sdcodex-updater:latest`, 39MB): merged all layers — **no app code**,
  sidecar only (Debian + docker CLI + `/update.sh`). Tar + notes since
  removed by user cleanup.
- `sdcodex-selfupdate:sdupdate-1792065581` (761MB) DID contain app code:
  recovered to `OldCode/docker recovery/temp-selfupdate-app/` (45 files).
  It is the OLD monolithic Flask layout (`app/*.py`, `templates/`, no
  VERSION file) — pre-rewrite reference. 739MB save-tar deleted after
  extraction. Full old-vs-current diff reported 2026-10-15 (see session);
  headline: `api.py`/`config.py`/`oidc.py` identical; auth/downloader/
  scanner/download_manager evolved; `routes.py`+`plugin_manager.py`+
  `docker_api.py`+`docker_selfupdate.py` replaced by `api_v1.py`+
  `updater.py`+`rebuilder.py` + React frontend.

## Rebuild flag
- `.rebuild-required` marker file (git-ignored), written by `mark_rebuild()`
- Triggers: core update, plugin install/uninstall, volume config changes
- Frontend shows "Rebuild required" banner with "Rebuild now" button
- Rebuild log: `.rebuild.log`, streamed to frontend via `GET /system/rebuild/log`

## Radial fan menu (2026-10-15 fix)
- Plugin `plugin.json` `icon` fields hold Material names (`photo_library`,
  `auto_fix_high`, `fas fa-tags`) — rendering them raw inside the 44px fan
  button produced floating text (screenshots 2026-10-15).
- User chose real glyphs over monograms: bundled `material-symbols` npm dep
  (offline-safe, baked into Docker build via `npm ci`), imported in
  `app/src/main.tsx` (`material-symbols/rounded.css`).
- New `app/src/components/fanIcon.tsx` renders the glyph: Material names via
  the Symbols font, Font Awesome classes via a FA→Material map
  (`fas fa-tags`→`sell`, etc.), single unicode glyphs as-is, anything else
  falls back to the plugin initial. `chrome.tsx` renders `<FanIcon/>`.
- Removed native `title` tooltips from fan buttons (duplicated the styled
  label as floating black tooltips); `aria-label` kept for accessibility.
- Hover glow hardened: 2px `#4cd7f6` outline + offset + stronger shadow
  (`app/src/index.css`). Fan spread math (180°→90° arc) unchanged.
- Stagger (2026-10-15): every second fan item sits 48px (one 44px icon +
  breathing room) closer to center — per-item `--fan-radius` override in
  `chrome.tsx`, no CSS change needed.
- Verified: `tsc --noEmit` clean, `npm run build` succeeds.

## Sidebar update badge (2026-10-15)
- Badge `onClick` → `goSettings('plugins')` (view=settings, tab=plugins,
  nonce remount) was already wired locally; deployed `sdcodex.deeplabs.qzz.io`
  shows v1.0.33 (repo is 1.0.34) so it may be testing a stale build.
- Hardened `Settings` (`app/src/views/Settings.tsx`): tab now also syncs via
  `useEffect` on `initialTab` change, not only on key-remount — badge works
  from any screen even on rapid double-click.
- Needs user confirmation: after rebuild, verify badge click lands on
  Settings → Plugins on the live host.

## Memory discipline (critical)
- **Any modification or system function deemed critical to app functioning or to
  development must be committed to this memory file** so we don't redo work.
- This includes: new endpoints, changed flows, config conventions, build/run
  commands, plugin behaviors, design rules, and any deviation from the norm.
- If something isn't 100% clear (a UI change, a function that diverges from the
  expected pattern), **ask for clarification** rather than guessing and writing it down.
- When in doubt about whether something is "critical": if it affects how the app
  runs, how we build/test, or how plugins/updates work — write it down.

## Release workflow (standing instruction, 2026-10-15)
- When a change is done and everything tests clean: commit + bump + push
  without asking.
- Core: commit the fix, bump `VERSION` (patch), push `upstream/main`.
- Hub (`Plugin-Hub/plugins.json`, own repo): bump `core.version` to match,
  commit, push `origin/main`. Both must agree or the update badge lies.
- Verify before pushing: frontend `npx tsc --noEmit` + `npm run build`;
  backend `python3 -m py_compile` on touched files (no backend suite exists).
