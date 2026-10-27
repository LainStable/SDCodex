import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hexToRgba } from './ui';
import { FanIcon } from './fanIcon';
import { AssistantBar } from './assistantBar';
import { getApiKey, getApiUser } from '../lib/settings';
import type { AssistantAction } from '../lib/assistant';

/* Shared chrome matching all four Stitch prototypes:
   sidebar order, topbar, page headers, buttons, stats. */

export type ViewId = 'home' | 'models' | 'library' | 'queue' | 'settings';

export const NAV: { id: ViewId; label: string; soon?: boolean }[] = [
  { id: 'home', label: 'Home' },
  { id: 'models', label: 'Model Explorer' },
  { id: 'library', label: 'Local Library' },
  { id: 'queue', label: 'Download Queue' },
];

const NAV_ICONS: Record<ViewId, string> = {
  home: 'fa-solid fa-house',
  models: 'fa-solid fa-compass',
  library: 'fa-solid fa-folder-open',
  queue: 'fa-solid fa-download',
  settings: 'fa-solid fa-gear',
};

export interface UpdateState {
  core: boolean;
  plugins: boolean;
  newPluginAvailable: boolean;
  checking: boolean;
}

export function Sidebar({
  view,
  go,
  pinned,
  onTogglePin,
  queueCount,
  version,
  updates,
  onGoPlugins,
  space,
  plugins,
  pluginPage,
  onPluginPage,
}: {
  view: ViewId;
  go: (v: ViewId) => void;
  /** Pinned open with the pin button; unpinned the rail expands on hover. */
  pinned: boolean;
  onTogglePin: () => void;
  queueCount: number;
  version: string;
  updates: UpdateState;
  onGoPlugins: () => void;
  /** Active space: core views or one installed plugin (sidebar swaps). */
  space: { kind: 'core' } | { kind: 'plugin'; id: string };
  plugins: Array<{
    id: string;
    name: string;
    version: string;
    nav_items: Array<{ label: string; icon?: string; page: string }>;
  }>;
  pluginPage: string | null;
  onPluginPage: (page: string) => void;
}) {
  const hasUpdate = updates.core || updates.plugins;
  const activePlugin =
    space.kind === 'plugin' ? plugins.find((p) => p.id === space.id) : undefined;
  const currentPage = pluginPage ?? activePlugin?.nav_items[0]?.page ?? null;

  const [gallerySources, setGallerySources] = useState<Array<{ id: string; label: string }>>([]);
  const [activeGallerySource, setActiveGallerySource] = useState<string>('media');
  // OldCode main-menu behaviour: the bar is a narrow icon rail that widens on
  // hover, with the labels already laid out behind the clipped edge. Pinning
  // keeps it open and reserves the expanded width in the page flow.
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;

  useEffect(() => {
    if (activePlugin?.id !== 'gallery') return;
    let live = true;
    fetch('/gallery/api/folderframe.config.json')
      .then((r) => r.json())
      .then((data) => {
        if (!live || !Array.isArray(data?.sources)) return;
        setGallerySources(data.sources.map((s: { id: string; label: string }) => ({ id: s.id, label: s.label })));
        if (data.defaults?.source) setActiveGallerySource(data.defaults.source);
      })
      .catch(() => {});
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'sdcodex:gallery-sources') {
        if (Array.isArray(e.data.sources)) {
          setGallerySources(e.data.sources.map((s: { id: string; label: string }) => ({ id: s.id, label: s.label })));
        }
        if (e.data.activeSourceId) setActiveGallerySource(e.data.activeSourceId);
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      live = false;
      window.removeEventListener('message', onMsg);
    };
  }, [activePlugin?.id]);

  return (
    <>
      {/* Spacer holds the rail's width in the page flow; only a pinned bar
          reserves the expanded column. Hover expansion overlays the page like
          the fixed OldCode menu instead of shifting content under the cursor. */}
      <div
        aria-hidden="true"
        className={`hidden shrink-0 transition-[width] duration-150 ease-out md:block ${pinned ? 'w-60' : 'w-16'}`}
      />
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setHovered(true)}
        onBlurCapture={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) setHovered(false);
        }}
        className={`fixed inset-y-0 left-0 z-30 hidden h-dvh flex-col overflow-hidden border-r border-white/[0.06] bg-obsidian-bg/95 backdrop-blur transition-[width] duration-150 ease-out md:flex ${
          open ? 'w-60 shadow-2xl shadow-black/50' : 'w-16'
        }`}
      >
        {open && (
          <button
            type="button"
            onClick={onTogglePin}
            title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            aria-pressed={pinned}
            className={`absolute right-1 top-1 z-20 flex h-5 w-5 items-center justify-center rounded transition-colors ${
              pinned
                ? 'bg-primary/20 text-primary hover:bg-primary/30'
                : 'text-ink-faint hover:bg-white/10 hover:text-white'
            }`}
          >
            <FanIcon
              icon="fa-solid fa-thumbtack"
              name="Pin sidebar"
              className={`!text-[11px] ${pinned ? '' : 'rotate-45'}`}
            />
          </button>
        )}

        {/* Fixed-width inner column: icons stay centred in the 64px rail while
            labels keep their layout and are revealed as the bar widens. */}
        <div className="flex h-full w-60 shrink-0 flex-col">
          <div className={`shrink-0 ${open ? 'px-3 pb-1 pt-3' : 'px-2 pb-1 pt-3'}`}>
            {open ? (
              <div className="pr-8">
                <img src="/codex.svg" alt="SDCodex" className="h-24 w-full object-fill" />
              </div>
            ) : (
              <div className="flex h-10 w-12 items-center justify-center" title="SDCodex">
                <img src="/sdcodex.svg" alt="SDCodex" className="h-8 w-8 object-contain" />
              </div>
            )}
          </div>

          {/* Only the nav scrolls, so the brand and footer stay on screen with long menus. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <nav className="space-y-1 text-sm">
              {activePlugin ? (
                <>
                  {activePlugin.version && (
                    <div className={`px-3 pb-1 transition-opacity duration-150 ${open ? 'opacity-100' : 'opacity-0'}`}>
                      <span
                        className="inline-block rounded border border-primary/40 bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold leading-none text-[#b9baff]"
                        title={`${activePlugin.name} · installed version ${activePlugin.version}`}
                      >
                        v{activePlugin.version}
                      </span>
                    </div>
                  )}
                  {activePlugin.nav_items.length > 0 && activePlugin.nav_items.map((item) => (
                    <button
                      key={item.page}
                      type="button"
                      onClick={() => onPluginPage(item.page)}
                      title={open ? undefined : item.label}
                      aria-label={open ? undefined : item.label}
                      className={`flex items-center rounded py-1 text-left transition-[width] duration-150 ${open ? 'w-full' : 'w-12'} ${
                        currentPage === item.page
                          ? 'bg-primary/15 text-white ring-1 ring-inset ring-primary/40'
                          : 'text-ink-muted hover:bg-white/5'
                      }`}
                    >
                      <span className="flex h-10 w-12 shrink-0 items-center justify-center">
                        <FanIcon icon={item.icon ?? 'extension'} name={item.label} className="!text-[18px]" />
                      </span>
                      <span className={`min-w-0 flex-1 truncate pr-2 transition-opacity duration-150 ${open ? 'opacity-100' : 'opacity-0'}`}>{item.label}</span>
                    </button>
                  ))}
                  {activePlugin.id === 'gallery' && gallerySources.length > 0 && (
                    <div className="mt-3 border-t border-white/[0.06] pt-3">
                      <div className={`px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint transition-opacity duration-150 ${open ? 'opacity-100' : 'opacity-0'}`}>
                        Sources
                      </div>
                      {gallerySources.map((source) => (
                        <button
                          key={source.id}
                          type="button"
                          onClick={() => {
                            setActiveGallerySource(source.id);
                            const iframes = document.querySelectorAll('iframe');
                            iframes.forEach((f) => {
                              f.contentWindow?.postMessage(
                                { type: 'sdcodex:set-source', sourceId: source.id },
                                window.location.origin,
                              );
                            });
                          }}
                          title={open ? undefined : source.label}
                          aria-label={open ? undefined : source.label}
                          className={`flex items-center rounded py-1 text-left text-xs transition-[width] duration-150 ${open ? 'w-full' : 'w-12'} ${
                            activeGallerySource === source.id
                              ? 'bg-primary/15 text-white ring-1 ring-inset ring-primary/40'
                              : 'text-ink-muted hover:bg-white/5'
                          }`}
                        >
                          <span className="flex h-8 w-12 shrink-0 items-center justify-center">
                            <FanIcon
                              icon={source.id === 'media' ? 'folder' : 'cloud'}
                              name={source.label}
                              className="!text-[16px] text-ink-faint"
                            />
                          </span>
                          <span className={`min-w-0 flex-1 truncate pr-2 transition-opacity duration-150 ${open ? 'opacity-100' : 'opacity-0'}`}>{source.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                NAV.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => go(item.id)}
                    title={open ? undefined : item.label}
                    aria-label={open ? undefined : item.label}
                    className={`flex items-center rounded py-1 text-left transition-[width] duration-150 ${open ? 'w-full' : 'w-12'} ${
                      view === item.id
                        ? 'bg-primary/15 text-white ring-1 ring-inset ring-primary/40'
                        : 'text-ink-muted hover:bg-white/5'
                    }`}
                  >
                    <span className="relative flex h-10 w-12 shrink-0 items-center justify-center">
                      <FanIcon icon={NAV_ICONS[item.id]} name={item.label} className="!text-[20px]" />
                      {item.id === 'queue' && queueCount > 0 && (
                        <span className="absolute right-0.5 top-0 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[9px] leading-4 text-obsidian">
                          {queueCount > 99 ? '99+' : queueCount}
                        </span>
                      )}
                    </span>
                    <span className={`flex min-w-0 flex-1 items-center gap-2 truncate pr-2 transition-opacity duration-150 ${open ? 'opacity-100' : 'opacity-0'}`}>
                      {item.label}
                      {item.soon && (
                        <span className="ml-1 rounded border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase text-ink-faint">
                          soon
                        </span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </nav>
          </div>

          <div className={`shrink-0 ${open ? 'p-3' : 'p-2'}`}>
            {open ? (
              <div className="space-y-2.5">
                <div className="font-mono text-[10px] leading-relaxed text-ink-faint">
                  <div className="flex items-center justify-between">
                    <span>Storage</span>
                    <span className="text-ink-muted">742 GB of 2 TB</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-white/10">
                    <div className="h-full w-[37%] rounded-sm bg-gradient-to-r from-primary to-secondary" />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  {hasUpdate ? (
                    <button
                      type="button"
                      onClick={onGoPlugins}
                      title={
                        updates.core
                          ? 'Core update available — open Plugin Hub to update'
                          : 'Plugin updates available — open Plugin Hub'
                      }
                      className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
                        updates.core
                          ? 'border-status-warning/50 bg-status-warning/15 text-[#fcd34d] hover:bg-status-warning/25'
                          : 'border-secondary/50 bg-secondary/15 text-[#22d3ee] hover:bg-secondary/25'
                      }`}
                    >
                      {updates.core ? '⟳' : '⬢'} v{version}
                    </button>
                  ) : (
                    <span className="rounded border border-white/20 bg-primary/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-white">
                      v{version}
                    </span>
                  )}
                  {updates.newPluginAvailable && (
                    <button
                      type="button"
                      onClick={onGoPlugins}
                      title="A new plugin is available to install — open Plugin Hub"
                      className="rounded border border-status-warning/50 bg-status-warning/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-[#fcd34d] hover:bg-status-warning/25"
                    >
                      NEW
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex w-12 flex-col items-center gap-2">
                <div className="h-1 w-8 overflow-hidden rounded-sm bg-white/10" title="Storage: 742 GB of 2 TB">
                  <div className="h-full w-[37%] rounded-sm bg-gradient-to-r from-primary to-secondary" />
                </div>
                {(hasUpdate || updates.newPluginAvailable) && (
                  <div className="flex flex-col items-center gap-1 font-mono text-[10px]">
                    {hasUpdate && (
                      <button
                        type="button"
                        onClick={onGoPlugins}
                        title={
                          updates.core
                            ? 'Core update available — open Plugin Hub to update'
                            : 'Plugin updates available — open Plugin Hub'
                        }
                        className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                          updates.core
                            ? 'border-status-warning/50 bg-status-warning/15 text-[#fcd34d]'
                            : 'border-secondary/50 bg-secondary/15 text-[#22d3ee]'
                        }`}
                      >
                        {updates.core ? '⟳' : '⬢'}
                      </button>
                    )}
                    {updates.newPluginAvailable && (
                      <button
                        type="button"
                        onClick={onGoPlugins}
                        title="A new plugin is available to install"
                        className="rounded border border-status-warning/50 bg-status-warning/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#fcd34d]"
                      >
                        +
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

export function MobileNav({
  view,
  go,
}: {
  view: ViewId;
  go: (v: ViewId) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 md:hidden">
      {NAV.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => go(item.id)}
          className={`rounded border px-2 py-1 text-xs ${
            view === item.id
              ? 'border-primary/50 bg-primary/20 text-white'
              : 'border-white/10 text-ink-muted'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function UserMenu({
  go,
  profileLabel,
  avatarUrl,
  signedIn,
  onSignOut,
  space,
  plugins,
  onSpaceCore,
  onSpacePlugin,
}: {
  go: (v: ViewId) => void;
  /** Avatar initials (or "?" for guests). */
  profileLabel: string;
  /** Uploaded picture data-URL, if set. */
  avatarUrl: string;
  signedIn: boolean;
  onSignOut: () => void;
  /** Active space + installed plugin spaces (fan icons). */
  space: { kind: 'core' } | { kind: 'plugin'; id: string };
  plugins: Array<{ id: string; name: string; icon?: string }>;
  onSpaceCore: () => void;
  onSpacePlugin: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Track the viewport so the arc grows/shrinks with the item count but never
  // runs off-screen when the window is resized.
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  // Fan-out arc: profile pic is the center (right side); items spread
  // left-to-bottom, i.e. 180° (west) → 90° (south) in screen coords.
  // Mirrors OldCode base.html: angle = start - (span * i) / (n - 1).
  // Fan: core icon (once a plugin is installed), one icon per installed
  // plugin, settings, sign out. Appearance lives in Settings → Profile.
  const actions: Array<{
    id: string;
    label: string;
    icon: string;
    run: () => void;
    current?: boolean;
    keep?: boolean;
  }> = [
    ...(plugins.length > 0
      ? [
          {
            id: 'space-core',
            label: 'models',
            icon: 'home',
            run: onSpaceCore,
            current: space.kind === 'core',
          },
        ]
      : []),
    ...plugins.map((p) => ({
      id: `space-${p.id}`,
      label: p.name,
      icon: (p.icon ?? '').trim() || p.name.trim().slice(0, 1).toUpperCase(),
      run: () => onSpacePlugin(p.id),
      current: space.kind === 'plugin' && space.id === p.id,
    })),
    { id: 'settings', label: 'Settings', icon: 'settings', run: () => go('settings') },
    signedIn
      ? { id: 'signout', label: 'Sign out', icon: 'arrow-right', run: onSignOut }
      : { id: 'signin', label: 'Sign in', icon: 'arrow-right', run: () => go('settings') },
  ];
  const n = actions.length;
  // One radial slot per item: the arc grows with the item count so adding or
  // removing a plugin respaces the fan, then clamps to the visible viewport.
  const idealRadius = 108 + n * 18;
  const maxRadius = Math.max(120, Math.min(viewport.w * 0.38, viewport.h - 180));
  const radius = Math.round(Math.max(120, Math.min(idealRadius, maxRadius)));
  const stagger = Math.min(48, radius * 0.18);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setMsg(null);
          setOpen((o) => !o);
        }}
        title="Account"
        aria-expanded={open}
        aria-label="Account menu"
        className={`fan-avatar block h-9 w-9 overflow-hidden rounded-lg bg-gradient-to-br from-primary via-secondary to-tertiary p-[2px] ${open ? 'open ring-2 ring-primary/60' : ''}`}
      >
        <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-obsidian-low font-display text-xs font-bold text-white">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            profileLabel
          )}
        </span>
      </button>

      <div
        className={`fan-layer${open ? ' open' : ''}`}
        style={{ '--fan-radius': `${radius}px` } as React.CSSProperties}
        role="menu"
        aria-hidden={!open}
      >
        {actions.map((a, i) => {
          const angle = n <= 1 ? 135 : 180 - (90 * i) / (n - 1);
          // Stagger: every second item sits slightly closer so the fan doesn't
          // cramp (icon width + breathing room, scaled with the radius).
          const itemRadius = i % 2 === 1 ? radius - stagger : radius;
          return (
            <div
              key={a.id}
              className="fan-item"
              style={
                {
                  '--fan-angle': `${angle.toFixed(2)}deg`,
                  '--fan-radius': `${itemRadius}px`,
                  transitionDelay: open ? `${i * 45}ms` : '0ms',
                } as React.CSSProperties
              }
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={open ? 0 : -1}
                aria-label={a.label}
                onClick={() => {
                  if (!a.keep) setOpen(false);
                  a.run();
                }}
                className={`glass-l2 flex h-11 w-11 items-center justify-center rounded-lg text-base hover:border-primary/50 ${
                  a.current ? 'border-primary/60 ring-1 ring-primary/50' : ''
                }`}
              >
                <FanIcon icon={a.icon} name={a.label} className="!text-[18px]" />
              </button>
              <span className="whitespace-nowrap rounded border border-white/10 bg-obsidian-low px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">
                {a.label}
              </span>
            </div>
          );
        })}
      </div>

      {msg && (
        <p className="glass-l2 absolute right-0 top-12 z-50 w-56 rounded-lg p-2 text-center font-mono text-[10px] text-status-warning">
          {msg}
        </p>
      )}
    </div>
  );
}

export function Topbar({
  installMode = 'local',
  go,
  profileLabel,
  avatarUrl,
  signedIn,
  onSignOut,
  space,
  plugins,
  onSpaceCore,
  onSpacePlugin,
  assistant,
}: {
  installMode?: 'docker' | 'local';
  go: (v: ViewId) => void;
  profileLabel: string;
  avatarUrl: string;
  signedIn: boolean;
  onSignOut: () => void;
  space: { kind: 'core' } | { kind: 'plugin'; id: string };
  plugins: Array<{ id: string; name: string; icon?: string }>;
  onSpaceCore: () => void;
  onSpacePlugin: (id: string) => void;
  assistant?: { configured: boolean; model: string; onAction: (action: AssistantAction) => void };
}) {
  return (
    <div className="mb-4 flex items-center gap-2 md:pr-12">
      <div className="glass-l1 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2">
        {assistant?.configured ? (
          <AssistantBar model={assistant.model} onAction={assistant.onAction} />
        ) : (
          <>
            <span className="text-ink-faint">⌕</span>
            <input
              data-search
              placeholder="Search models, paths, plugins…  ( / )"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 font-mono text-[10px] text-ink-faint">
              /
            </kbd>
          </>
        )}
      </div>
      <span
        title="Running mode — Docker container vs local process"
        className={`hidden rounded border px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] sm:inline ${
          installMode === 'local'
            ? 'border-status-active/30 bg-status-active/10 text-status-active'
            : 'border-primary/30 bg-primary/10 text-[#a5b4fc]'
        }`}
      >
        {installMode}
      </span>
      {/* The account/radial menu stays in the top-right corner while the page
          scrolls; the search bar and the mode badge scroll away with it. The
          row reserves the button's width so nothing slides underneath. */}
      <div className="md:fixed md:right-5 md:top-5 md:z-40">
        <UserMenu
          go={go}
          profileLabel={profileLabel}
          avatarUrl={avatarUrl}
          signedIn={signedIn}
          onSignOut={onSignOut}
          space={space}
          plugins={plugins}
          onSpaceCore={onSpaceCore}
          onSpacePlugin={onSpacePlugin}
        />
      </div>
    </div>
  );
}

export function CivitaiAccountStatus() {
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey()));
  const [apiUser, setApiUser] = useState(getApiUser);

  useEffect(() => {
    const refresh = () => {
      setHasKey(Boolean(getApiKey()));
      setApiUser(getApiUser());
    };
    const onKeyChange = () => void refresh();
    void refresh();
    window.addEventListener('sdcodex:api-key-changed', onKeyChange);
    window.addEventListener('sdcodex:api-user-changed', onKeyChange);
    return () => {
      window.removeEventListener('sdcodex:api-key-changed', onKeyChange);
      window.removeEventListener('sdcodex:api-user-changed', onKeyChange);
    };
  }, []);

  const userLabel = apiUser
    ? `Civitai account @${apiUser}`
    : hasKey
      ? 'Civitai account not verified'
      : 'Civitai account not signed in';
  const userColor = apiUser
    ? 'border-status-active/40 bg-status-active/10 text-status-active'
    : 'border-status-warning/40 bg-status-warning/10 text-[#fcd34d]';
  return (
    <span
      title={userLabel}
      aria-label={userLabel}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] ${userColor}`}
    >
      {apiUser ? `@${apiUser}` : hasKey ? 'Unverified' : 'Signed out'}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
}: {
  title: string;
  subtitle: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
        {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">{subtitle}</p>
      {meta && <div className="mt-2 font-mono text-[11px] text-ink-faint">{meta}</div>}
    </header>
  );
}

export function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded border border-primary/50 bg-primary/20 px-4 py-2 text-sm font-semibold text-ink hover:bg-primary/30 disabled:opacity-50 ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded border border-ink/15 px-3 py-1.5 text-xs text-ink-muted hover:bg-ink/5 hover:text-ink disabled:opacity-40 ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function DangerButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded border border-status-alert/40 px-3 py-1.5 font-mono text-[11px] text-[#f87171] hover:bg-status-alert/10 ${rest.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-l1 rounded-lg p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
        {label}
      </div>
      <div className="mt-1 font-display text-xl font-semibold">{value}</div>
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      data-search
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="min-w-[220px] flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/25"
    />
  );
}

export function FilterPills<T extends string>({
  options,
  active,
  onPick,
  activeColor,
}: {
  options: { id: T; label: string; color?: string }[];
  active: T;
  onPick: (id: T) => void;
  /** Optional accent for the active pill when an option has no own colour. */
  activeColor?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((f) => {
        const isActive = active === f.id;
        // Selected tabs carry the category colour (same size/weight as the
        // TypeBadge); unselected tabs stay neutral grey.
        const color = isActive ? (f.color ?? activeColor) : undefined;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onPick(f.id)}
            aria-pressed={isActive}
            style={
              color
                ? {
                    color,
                    borderColor: hexToRgba(color, 0.7),
                    backgroundColor: hexToRgba(color, 0.22),
                  }
                : undefined
            }
            className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
              color
                ? ''
                : isActive
                  ? 'border-primary/50 bg-primary/20 text-white'
                  : 'border-white/10 bg-white/5 text-ink-muted hover:border-white/20'
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

/** Multi-toggle base-model cloud (matches the reference filter cloud). */
export function BaseCloud({
  options,
  active,
  onToggle,
  onClear,
}: {
  options: readonly string[];
  active: string[];
  onToggle: (b: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
          {active.length > 0 ? `(${active.length})` : ''}
        </span>
        {active.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] text-secondary hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      <div className="noscroll flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
        {options.map((b) => {
          const on = active.includes(b);
          return (
            <button
              key={b}
              type="button"
              onClick={() => onToggle(b)}
              className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                on
                  ? 'border-primary/60 bg-primary/25 text-white'
                  : 'border-primary/25 bg-primary/[0.07] text-[#b9baff] hover:border-primary/50'
              }`}
            >
              {b}
            </button>
          );
        })}
      </div>
    </div>
  );
}
