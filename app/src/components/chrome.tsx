import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hexToRgba } from './ui';

/* Shared chrome matching all four Stitch prototypes:
   sidebar order, topbar, page headers, buttons, stats. */

export type ViewId = 'home' | 'models' | 'library' | 'queue' | 'settings';

export const NAV: { id: ViewId; label: string; soon?: boolean }[] = [
  { id: 'home', label: 'Home' },
  { id: 'models', label: 'Model Explorer' },
  { id: 'library', label: 'Local Library' },
  { id: 'queue', label: 'Download Queue' },
];

export interface UpdateState {
  core: boolean;
  plugins: boolean;
  checking: boolean;
}

export function Sidebar({
  view,
  go,
  queueCount,
  version,
  updates,
  updating,
  onUpdateCore,
  onGoPlugins,
  space,
  plugins,
  pluginPage,
  onPluginPage,
}: {
  view: ViewId;
  go: (v: ViewId) => void;
  queueCount: number;
  version: string;
  updates: UpdateState;
  updating: boolean;
  onUpdateCore: () => void;
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
  return (
    <aside className="hidden w-60 shrink-0 border-r border-white/[0.06] p-4 md:block">
      <div className="font-display text-lg font-bold tracking-tight">SDCodex</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
        {hasUpdate ? (
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              disabled={updating}
              onClick={() => {
                if (updates.core) onUpdateCore();
                else onGoPlugins();
              }}
              title={
                updates.core
                  ? 'Core update available — click to update'
                  : 'Plugin updates available — open Plugin Hub'
              }
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
                updates.core
                  ? 'border-status-warning/50 bg-status-warning/15 text-[#fcd34d] hover:bg-status-warning/25'
                  : 'border-secondary/50 bg-secondary/15 text-[#22d3ee] hover:bg-secondary/25'
              }`}
            >
              {updates.core ? (updating ? '⟳…' : '⟳') : '⬢'} v{version}
            </button>
          </span>
        ) : (
          <span>v{version}</span>
        )}
      </div>
      <nav className="mt-6 space-y-1 text-sm">
        {activePlugin ? (
          <>
            <div className="px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
              {activePlugin.name}
              {activePlugin.version ? ` · v${activePlugin.version}` : ''}
            </div>
            {activePlugin.nav_items.map((item) => (
              <button
                key={item.page}
                type="button"
                onClick={() => onPluginPage(item.page)}
                className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left ${
                  currentPage === item.page
                    ? 'bg-primary/15 text-white ring-1 ring-inset ring-primary/40'
                    : 'text-ink-muted hover:bg-white/5'
                }`}
              >
                {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                <span>{item.label}</span>
              </button>
            ))}
          </>
        ) : (
          NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => go(item.id)}
            className={`flex w-full items-center justify-between rounded px-3 py-2 text-left ${
              view === item.id
                ? 'bg-primary/15 text-white ring-1 ring-inset ring-primary/40'
                : 'text-ink-muted hover:bg-white/5'
            }`}
          >
            <span>
              {item.label}
              {item.soon && (
                <span className="ml-2 rounded border border-white/15 px-1.5 font-mono text-[9px] uppercase text-ink-faint">
                  soon
                </span>
              )}
            </span>
            {item.id === 'queue' && queueCount > 0 && (
              <span className="rounded bg-primary/30 px-1.5 font-mono text-[10px]">
                {queueCount}
              </span>
            )}
            </button>
          )))
        }
      </nav>
      <div className="mt-6 border-t border-white/[0.06] pt-3 font-mono text-[10px] leading-relaxed text-ink-faint">
        Storage
        <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-white/10">
          <div className="h-full w-[37%] rounded-sm bg-gradient-to-r from-primary to-secondary" />
        </div>
        <div className="mt-1">742 GB of 2 TB</div>
      </div>
    </aside>
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

export type Theme = 'dark' | 'light';

export function UserMenu({
  go,
  theme,
  setTheme,
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
  theme: Theme;
  setTheme: (t: Theme) => void;
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
  // Fan: theme toggle, core icon (once a plugin is installed), one icon per
  // installed plugin, settings, sign out. Core icon returns to core views.
  // The theme toggle keeps the fan open (click-off still closes it).
  const actions: Array<{
    id: string;
    label: string;
    icon: string;
    run: () => void;
    current?: boolean;
    keep?: boolean;
  }> = [
    theme === 'dark'
      ? { id: 'theme', label: 'Light', icon: '☀', run: () => setTheme('light'), current: false, keep: true }
      : { id: 'theme', label: 'Dark', icon: '☾', run: () => setTheme('dark'), current: false, keep: true },
    ...(plugins.length > 0
      ? [
          {
            id: 'space-core',
            label: 'Core',
            icon: '⌂',
            run: onSpaceCore,
            current: space.kind === 'core',
          },
        ]
      : []),
    ...plugins.map((p) => ({
      id: `space-${p.id}`,
      label: p.name,
      icon: p.icon || p.name.slice(0, 1).toUpperCase(),
      run: () => onSpacePlugin(p.id),
      current: space.kind === 'plugin' && space.id === p.id,
    })),
    { id: 'settings', label: 'Settings', icon: '⚙', run: () => go('settings') },
    signedIn
      ? { id: 'signout', label: 'Sign out', icon: '→', run: onSignOut }
      : { id: 'signin', label: 'Sign in', icon: '→', run: () => go('settings') },
  ];
  const n = actions.length;

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

      <div className={`fan-layer${open ? ' open' : ''}`} role="menu" aria-hidden={!open}>
        {actions.map((a, i) => {
          const angle = n <= 1 ? 135 : 180 - (90 * i) / (n - 1);
          return (
            <div
              key={a.id}
              className="fan-item"
              style={
                {
                  '--fan-angle': `${angle.toFixed(2)}deg`,
                  transitionDelay: open ? `${i * 45}ms` : '0ms',
                } as React.CSSProperties
              }
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={open ? 0 : -1}
                title={a.label}
                onClick={() => {
                  if (!a.keep) setOpen(false);
                  a.run();
                }}
                className={`glass-l2 flex h-11 w-11 items-center justify-center rounded-lg text-base hover:border-primary/50 ${
                  a.current ? 'border-primary/60 ring-1 ring-primary/50' : ''
                }`}
              >
                {a.icon}
              </button>
              <span className="whitespace-nowrap rounded border border-white/10 bg-obsidian-low px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-muted">
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
  socket = 'rw',
  go,
  theme,
  setTheme,
  profileLabel,
  avatarUrl,
  signedIn,
  onSignOut,
  space,
  plugins,
  onSpaceCore,
  onSpacePlugin,
}: {
  socket?: 'rw' | 'ro';
  go: (v: ViewId) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  profileLabel: string;
  avatarUrl: string;
  signedIn: boolean;
  onSignOut: () => void;
  space: { kind: 'core' } | { kind: 'plugin'; id: string };
  plugins: Array<{ id: string; name: string; icon?: string }>;
  onSpaceCore: () => void;
  onSpacePlugin: (id: string) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <div className="glass-l1 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2">
        <span className="text-ink-faint">⌕</span>
        <input
          data-search
          placeholder="Search models, paths, plugins…  ( / )"
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
        <kbd className="rounded border border-white/10 bg-white/5 px-1.5 font-mono text-[10px] text-ink-faint">
          /
        </kbd>
      </div>
      <span
        className={`hidden rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] sm:inline ${
          socket === 'rw'
            ? 'border-status-active/30 bg-status-active/10 text-status-active'
            : 'border-status-warning/30 bg-status-warning/10 text-[#fcd34d]'
        }`}
      >
        socket: {socket}
      </span>
      <button
        type="button"
        className="glass-l1 rounded-lg px-3 py-2 text-sm text-ink-muted hover:text-white"
        title="Sync (backend pending)"
      >
        ⇄
      </button>
      <UserMenu
        go={go}
        theme={theme}
        setTheme={setTheme}
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
      className={`rounded border border-primary/50 bg-primary/20 px-4 py-2 text-sm font-semibold text-white hover:bg-primary/30 disabled:opacity-50 ${rest.className ?? ''}`}
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
      className={`rounded border border-white/15 px-3 py-1.5 text-xs text-ink-muted hover:bg-white/5 hover:text-white disabled:opacity-40 ${rest.className ?? ''}`}
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
  options: { id: T; label: string }[];
  active: T;
  onPick: (id: T) => void;
  /** Optional accent for the active pill (e.g. category color). */
  activeColor?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((f) => {
        const isActive = active === f.id;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onPick(f.id)}
            style={
              isActive && activeColor
                ? {
                    borderColor: hexToRgba(activeColor, 0.6),
                    backgroundColor: hexToRgba(activeColor, 0.25),
                    color: '#fff',
                  }
                : undefined
            }
            className={`rounded border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
              isActive
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
          Base{active.length > 0 ? ` (${active.length})` : ''}:
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
