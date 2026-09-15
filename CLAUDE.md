# SDCodex

Stitch project `projects/4032984165089508769` (SDCodex). Dark-first workstation for model/checkpoint/LoRA management.

## Design source
- `DESIGN.md` — Obsidian Codex tokens (surface `#0f131c`, primary `#6366f1`, Geist/Inter/JetBrains Mono). Canonical for colors/type/spacing. **Exception: badges/pills are square** (`rounded-[3px]`/`rounded`, per user screenshot) — NOT the fully-rounded pills in DESIGN.md.
- `stitch/html/` — 11 screen prototypes (library, queue, scraper, hub, auth, gallery HUD, tagger, rembg, disk browser, explorer). Reference before building.
- `stitch/project.json`, `screens.json`, `design-systems.json` — Stitch metadata.

## Stack
- `app/` — Vite 8 + React 19 + TS + Tailwind 3 (slice 1: Library). Run commands from `app/`.
- Build: `npm run build` (`tsc -b && vite build`) · Dev: `npm run dev` · Lint: `npm run lint` (`oxlint`) · Preview: `npm run preview`
- No test runner yet.
- Core views in `app/src/views/` (`Explorer` = live Civitai API, `Library` = local mocks, `Core` = Home + Queue stub). API client `app/src/lib/civitai.ts`, queue store `app/src/lib/queue.ts` (localStorage until backend lands).
- `Detail` view = per-model versions/files + creator→search link (mirrors OldCode `/model/<id>`). Queue items carry `modelId`/`versionId` per `DownloadManager.add_task`. Library `Scanner` uses File System Access API + `fetchVersionByHash` (mirrors `scanner.scan_directory`); Chromium-only, mocks work everywhere. Global `/` focuses search.
- Floating `ModelModal` (zoom-out open) replaces the old detail page: tags, version pills, wheel-cycled gallery + checkerboard lightbox, Details table (author/type/base/hash/updated), per-file hashes with Download/Delete, description, embedded PNG generation data (Auto1111 parameters / Comfy prompt+workflow) with a ComfyCaption-plugin note. Explorer + Library cards open it.
- Scan engine lives in `app/src/lib/scan.ts` and runs from Settings → Model dirs (per-row Link + Scan, global Scan all); folder picks persist in IndexedDB (`lib/idb.ts`), records mirror `Download` rows (`lib/library.ts`). Library page shows results only.
- `Settings` view (tabs: Download dirs, API key, Users & SSO, System) mirrors OldCode `/settings` tabs. Dir keys (`dir_<type>`, custom) and API key persist to localStorage under the same names the backend `Setting` table will adopt; Civitai client sends Bearer token when set. Auth/SSO + self-update panels are honest read-only stubs until the backend lands.
- Auth is frontend-local preview shaped like the backend (`lib/auth.ts` mirrors `User`/`OidcConfig`): blocking gate (no session = no app), bootstrap creates the first user as admin with a PBKDF2-SHA256 password hash (browser stand-in for OldCode scrypt; min 8 chars), avatar shows initials, fan offers Sign in/out. OIDC manager (admin-only, same page) stores provider rows locally with real discovery-Test and PKCE sign-in URLs; no passwords stored client-side. Sidebar has no Settings entry — gear in the radial fan routes there.

## ECC
- Global opencode profile already installed (`~/.config/opencode`). Prefer skills-first; see `/ecc-guide`.

## Backend
- `backend/` — Flask + SQLAlchemy (SQLite `backend/data/sdcodex.db`, gitignored). Revived from `OldCode/` as package `sdcodex`; serves JSON at `/api` (`api_v1.py`: health, auth, settings, downloads, library, scan, OIDC). Run: `python3 run.py` from `backend/` (port 5000).
- Frontend talks same-origin `/api` (Vite proxy in dev, backend serves in prod) via `app/src/lib/backend.ts`. Backend-first with localStorage fallback: startup pulls settings, saves push through, auth bootstrap/login mirrors the User row + cookie, queue POSTs to the real `DownloadManager` worker.
- Civitai calls go through the dev `/civitai` proxy (preflight rejects browser Bearer headers cross-origin).
