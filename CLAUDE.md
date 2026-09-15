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
- `Settings` view (tabs: Download dirs, API key, Users & SSO, System) mirrors OldCode `/settings` tabs. Dir keys (`dir_<type>`, custom) and API key persist to localStorage under the same names the backend `Setting` table will adopt; Civitai client sends Bearer token when set. Auth/SSO + self-update panels are honest read-only stubs until the backend lands.
- Auth is frontend-local preview shaped like the backend (`lib/auth.ts` mirrors `User`/`OidcConfig`): bootstrap creates the first user as admin, avatar shows initials, fan offers Sign in/out. OIDC manager (admin-only, same page) stores provider rows locally with real discovery-Test and PKCE sign-in URLs; no passwords stored client-side. Sidebar has no Settings entry — gear in the radial fan routes there.

## ECC
- Global opencode profile already installed (`~/.config/opencode`). Prefer skills-first; see `/ecc-guide`.
