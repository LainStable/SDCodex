import { useEffect, useState } from 'react';
import {
  DangerButton,
  FilterPills,
  GhostButton,
  PageHeader,
  PrimaryButton,
  SearchInput,
  Stat,
} from '../components/chrome';
import { isPaused, setPaused, type QueueItem } from '../lib/queue';
import { bootstrapUser, startSession, verifyPassword, type Profile } from '../lib/auth';
import { adoptServerUser, fetchPublicProviders, type ServerAuthState } from '../lib/auth';
import { apiPost, mirrorAuth } from '../lib/backend';
import { fetchCatalog, type HubCatalog } from '../lib/plugins';

/** Blocking auth gate (mirrors OldCode bootstrap + login). No session, no app:
    first-ever user sets a password and becomes admin; returning users sign in. */
export function BootstrapCard({
  existing,
  serverMode,
  serverBootstrap,
  onServerChanged,
  onSwitchUser,
  onDone,
}: {
  existing: Profile | null;
  /** When true, the backend verifies (fresh origins with no local hash). */
  serverMode: boolean;
  /** Server user count (only meaningful in serverMode). */
  serverBootstrap: boolean;
  /** Called when the server disagrees (e.g. users appeared) so App re-checks. */
  onServerChanged?: () => void;
  /** Clear the saved profile so a different user can sign in. */
  onSwitchUser?: () => void;
  onDone: (p: Profile) => void;
}) {
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<Array<{ id: number; name: string; host: string }>>([]);
  const [faviconSrc, setFaviconSrc] = useState<Record<number, number>>({});

  /** Favicon cascade: provider root, Authentik convention, icon service, hidden. */
  const faviconFor = (p: { id: number; host: string }): string | null => {
    if (!p.host) return null;
    const step = faviconSrc[p.id] ?? 0;
    if (step === 0) return `https://${p.host}/favicon.ico`;
    if (step === 1) return `https://${p.host}/api/application-images/favicon`;
    if (step === 2) return `https://icons.duckduckgo.com/ip3/${p.host}.ico`;
    return null;
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      if (!serverMode) return;
      const list = await fetchPublicProviders();
      if (live) setSso(list);
    })();
    return () => {
      live = false;
    };
  }, [serverMode]);

  const submit = async () => {
    setError(null);
    // The gate always shows the full form: username is entered explicitly
    // every time (a saved profile only pre-fills it). Verification below is
    // unchanged — local hash when it matches, backend otherwise.
    const loginName = (existing ? existing.username : username).trim();
    if (isCreate) {
      if (!loginName) {
        setError('Choose a username.');
        return;
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        setError('Passwords do not match.');
        return;
      }
    } else if (!loginName) {
      setError('Enter your username.');
      return;
    } else if (!password) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    try {
      if (!isCreate) {
        const saved = existing && existing.username === loginName ? existing : null;
        if (serverMode && !saved?.passwordHash) {
          // No usable local hash — verify against the backend directly.
          const r = await apiPost<{ ok: boolean; user: ServerAuthState['user'] }>('/auth/login', {
            username: loginName,
            password,
          });
          const adopted = adoptServerUser(r.user);
          if (!adopted) throw new Error('Login failed');
          startSession();
          onDone(adopted);
          return;
        }
        if (!saved) {
          setError('Unknown user on this device — check the name or create it first.');
          return;
        }
        const ok = await verifyPassword(password, saved.passwordHash);
        if (!ok) {
          setError('Wrong password.');
          return;
        }
        startSession();
        // Mirror into the backend when reachable (same User row + cookie).
        try {
          await mirrorAuth('login', { username: saved.username, password });
        } catch {
          /* standalone — local session stands */
        }
        onDone(saved);
        return;
      }
      if (serverMode && !serverBootstrap) {
        // Backend owns accounts and this origin has no profile — plain login.
        const r = await apiPost<{ ok: boolean; user: ServerAuthState['user'] }>('/auth/login', {
          username: loginName,
          password,
        });
        const adopted = adoptServerUser(r.user);
        if (!adopted) throw new Error('Login failed');
        startSession();
        onDone(adopted);
        return;
      }
      if (serverMode) {
        try {
          const r = await apiPost<{ ok: boolean; user: ServerAuthState['user'] }>('/auth/bootstrap', {
            username: loginName,
            displayName: display,
            password,
          });
          const adopted = adoptServerUser(r.user);
          if (!adopted) throw new Error('Bootstrap failed');
          startSession();
          onDone(adopted);
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Could not create account.';
          if (/already exist/i.test(msg)) {
            // Server state moved under us (second backend, double tab, race):
            // re-check instead of dead-ending, so the gate flips to Sign in.
            setError('Users exist now — switching to sign-in…');
            onServerChanged?.();
          } else {
            setError(msg);
          }
        } finally {
          setBusy(false);
        }
        return;
      }
      const created = await bootstrapUser(loginName, display, password);
      try {
        await mirrorAuth('bootstrap', { username: loginName, displayName: display, password });
      } catch {
        /* standalone — local account stands */
      }
      onDone(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create account.');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit();
  };

  const isCreate = !existing && (!serverMode || serverBootstrap);

  // Pre-fill the username from a saved profile; it stays editable so a
  // different user can always sign in.
  useEffect(() => {
    if (existing) setUsername((u) => u || existing.username);
  }, [existing]);

  return (
    <div onKeyDown={onKey}>
      <div className="flex flex-col items-center">
        <img src="/sdcodex.svg" alt="SDCodex" className="h-24 w-24" />
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          autoComplete="username"
          className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
        />
        {isCreate && (
          <input
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            placeholder="Display name (optional)"
            autoComplete="nickname"
            className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
          />
        )}
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={existing || !isCreate ? 'Password' : 'Password (min 8 characters)'}
          type="password"
          autoComplete={existing || !isCreate ? 'current-password' : 'new-password'}
          className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
        />
        {isCreate && (
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            type="password"
            autoComplete="new-password"
            className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
          />
        )}
        {error && <p className="font-mono text-[11px] text-status-alert">{error}</p>}
        <PrimaryButton
          className="mx-6"
          disabled={busy || !username.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Working…' : !isCreate ? 'Sign in' : 'Create administrator'}
        </PrimaryButton>
        {existing && onSwitchUser && (
          <button
            type="button"
            onClick={onSwitchUser}
            className="text-center font-mono text-[11px] text-ink-faint hover:text-white"
          >
            Sign in as someone else
          </button>
        )}
        {sso.map((p) => (
          <GhostButton
            key={p.id}
            className="mx-6"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setError(null);
                setBusy(true);
                try {
                  const { serverLoginUrl } = await import('../lib/auth');
                  window.location.href = await serverLoginUrl(String(p.id));
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'SSO failed.');
                  setBusy(false);
                }
              })()
            }
          >
            <span className="inline-flex items-center gap-2">
              {faviconFor(p) && (
                <img
                  src={faviconFor(p)!}
                  alt=""
                  className="h-4 w-4 rounded-sm"
                  onError={() => setFaviconSrc((f) => ({ ...f, [p.id]: (f[p.id] ?? 0) + 1 }))}
                />
              )}
              Sign in with {p.name}
            </span>
          </GhostButton>
        ))}
      </div>
    </div>
  );
}

export function Home({ go }: { go: (v: 'models' | 'library' | 'queue' | 'settings') => void }) {  const cards = [
    { id: 'models' as const, title: 'Model Explorer', desc: 'Browse Civitai by type, base model, and tags.' },
    { id: 'library' as const, title: 'Local Library', desc: 'Downloaded weights with metadata and socket state.' },
    { id: 'queue' as const, title: 'Download Queue', desc: 'Background downloads staged from Models.' },
    { id: 'settings' as const, title: 'Plugins & Settings', desc: 'Installable plugins, model dirs, keys, access.' },
  ];
  return (
    <div>
      <PageHeader
        title="SDCodex"
        subtitle="Modular Stable Diffusion workstation. Core first: browse models, manage the local library, queue downloads — then plugins."
      />
      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => go(c.id)}
            className="glass-l1 rounded-lg p-4 text-left transition-colors hover:border-primary/40"
          >
            <div className="font-display text-base font-semibold">{c.title}</div>
            <div className="mt-1 text-xs text-ink-muted">{c.desc}</div>
          </button>
        ))}
      </section>
    </div>
  );
}

const STATUS_STYLE: Record<QueueItem['status'], string> = {
  queued: 'border-white/15 bg-white/5 text-ink-muted',
  downloading: 'border-secondary/40 bg-secondary/10 text-[#22d3ee]',
  done: 'border-status-active/40 bg-status-active/10 text-status-active',
};

export function Queue({
  items,
  onRemove,
  onClearCompleted,
  onClearAll,
}: {
  items: QueueItem[];
  onRemove: (id: string) => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
}) {
  const [paused, setPausedState] = useState(isPaused);
  const [speedLimit, setSpeedLimit] = useState('Unlimited');
  const [maxParallel, setMaxParallel] = useState(1);
  const [server, setServer] = useState<{
    active: Array<{ type?: string; model_id?: number; version_id?: number; status?: string; progress?: number; message?: string }>;
    queued: number;
    max: number;
    reachable: boolean;
  }>({ active: [], queued: 0, max: 1, reachable: false });
  const active = items.filter((i) => i.status !== 'done');

  const togglePaused = () => {
    const next = !paused;
    setPaused(next);
    setPausedState(next);
  };

  // Backend worker state: max-parallel setting + live task polling.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      const { apiGet, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) return;
      try {
        const s = await apiGet<{ maxParallel?: number }>('/settings');
        if (live && typeof s.maxParallel === 'number') {
          setMaxParallel(Math.max(1, Math.min(8, s.maxParallel)));
        }
      } catch {
        /* keep default */
      }
      const poll = async () => {
        try {
          const st = await apiGet<{
            active_tasks?: Array<{ type?: string; model_id?: number; version_id?: number; status?: string; progress?: number; message?: string }>;
            queue_length?: number;
            max_parallel?: number;
          }>('/downloads/status');
          if (!live) return;
          setServer({
            active: st.active_tasks ?? [],
            queued: st.queue_length ?? 0,
            max: st.max_parallel ?? 1,
            reachable: true,
          });
        } catch {
          /* worker offline — local list stands */
        }
      };
      await poll();
      timer = setInterval(() => void poll(), 2500);
    })();
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  const saveParallel = async (n: number) => {
    const v = Math.max(1, Math.min(8, n || 1));
    setMaxParallel(v);
    try {
      const { apiPost, backendAvailable } = await import('../lib/backend');
      if (await backendAvailable()) await apiPost('/settings', { maxParallel: v });
    } catch {
      /* standalone */
    }
  };

  return (
    <div>
      <PageHeader
        title="Download Manager"
        subtitle="Background worker streams weights with hash verification and metadata scraping. Beyond the parallel limit, downloads wait in queue."
        meta={`${server.reachable ? server.active.length : active.length} active · ${server.reachable ? server.queued : 0} queued on server · 1.4 TB available`}
        actions={
          <>
            {paused ? (
              <PrimaryButton onClick={togglePaused}>Resume all</PrimaryButton>
            ) : (
              <GhostButton onClick={togglePaused}>Pause all</GhostButton>
            )}
            <GhostButton onClick={onClearCompleted}>Clear completed</GhostButton>
          </>
        }
      />

      <section className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Throughput" value="— MB/s" />
        <Stat
          label="Active sockets"
          value={`${server.reachable ? server.active.length : active.length} of ${server.reachable ? server.max : maxParallel}`}
        />
        <Stat label="Staged" value={String(items.length)} />
        <Stat label="State" value={paused ? 'Paused' : 'Ready'} />
      </section>

      <div className="glass-l1 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg p-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Parallel downloads
          </span>
          <input
            type="number"
            min={1}
            max={8}
            value={maxParallel}
            onChange={(e) => void saveParallel(Number(e.target.value))}
            className="w-16 rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-xs outline-none focus:border-primary"
          />
        </label>
        <span className="font-mono text-[10px] text-ink-faint">
          {server.reachable ? 'enforced by the worker' : 'applies when the backend is up'}
        </span>
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Speed limiter
          </span>
          <select
            value={speedLimit}
            onChange={(e) => setSpeedLimit(e.target.value)}
            className="rounded border border-white/10 bg-obsidian-lowest px-2 py-1 text-xs outline-none focus:border-primary"
          >
            {['Unlimited', '50 MB/s', '25 MB/s', '10 MB/s'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {items.length > 0 && (
          <DangerButton className="ml-auto" onClick={onClearAll}>
            Clear all
          </DangerButton>
        )}
      </div>

      {server.reachable && (server.active.length > 0 || server.queued > 0) && (
        <div className="mt-3">
          <h2 className="font-display text-sm font-semibold">Worker</h2>
          <ul className="mt-2 space-y-2">
            {server.active.map((t, i) => (
              <li key={`${t.model_id}-${t.version_id}-${i}`} className="glass-l1 rounded-lg p-3">
                <div className="flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">
                      {t.type === 'scan' ? 'Library scan' : `model ${t.model_id ?? '?'} · version ${t.version_id ?? '?'}`}
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-muted">
                      {t.message || t.status || 'running'}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-ink">{t.progress ?? 0}%</span>
                  {t.type !== 'scan' && (
                    <button
                      type="button"
                      title="Cancel download"
                      onClick={() =>
                        void (async () => {
                          try {
                            const { apiPost } = await import('../lib/backend');
                            await apiPost('/downloads/cancel', {
                              modelId: t.model_id,
                              versionId: t.version_id,
                            });
                          } catch {
                            /* poll refreshes */
                          }
                        })()
                      }
                      className="rounded border border-white/15 px-2 py-0.5 font-mono text-xs text-ink-faint hover:border-status-alert/50 hover:text-[#f87171]"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-white/10">
                  <div
                    className="h-full rounded-sm bg-gradient-to-r from-primary to-secondary transition-all"
                    style={{ width: `${t.progress ?? 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {items.length === 0 ? (
        <p className="glass-l1 mt-3 rounded-lg p-6 text-center font-mono text-xs text-ink-faint">
          Queue is empty — stage downloads from Models.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((i) => (
            <li key={i.id} className="glass-l1 rounded-lg p-3">
              <div className="flex items-center gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{i.name}</div>
                  <div className="truncate font-mono text-[11px] text-ink-muted">
                    {i.detail}
                  </div>
                </div>
                <span
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[i.status]}`}
                >
                  {paused && i.status !== 'done' ? 'paused' : i.status}
                </span>
                <span className="font-mono text-[11px] text-ink">
                  {i.progress != null ? `${i.progress}%` : 'staged'}
                </span>
                <button
                  type="button"
                  title="Remove from queue"
                  onClick={() => onRemove(i.id)}
                  className="rounded border border-white/15 px-2 py-0.5 font-mono text-xs text-ink-faint hover:border-status-alert/50 hover:text-[#f87171]"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-white/10">
                <div
                  className="h-full rounded-sm bg-gradient-to-r from-primary to-secondary transition-all"
                  style={{ width: `${i.progress ?? 0}%` }}
                />
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                hash: pending verify · {i.downloadUrl || 'no direct URL'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Floating Downloads & Queue panel (top right, all pages). Matches the
    reference: active rows with progress, queued summary, full-queue link. */
export function DownloadFloat({ go }: { go: (v: 'queue') => void }) {
  const [state, setState] = useState<{
    active: Array<{ model_id?: number; version_id?: number; message?: string; progress?: number }>;
    queued: number;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const { apiGet, backendAvailable } = await import('../lib/backend');
        if (!(await backendAvailable())) {
          if (live) setState(null);
          return;
        }
        const st = await apiGet<{
          active_tasks?: Array<{ model_id?: number; version_id?: number; message?: string; progress?: number }>;
          queue_length?: number;
        }>('/downloads/status');
        if (!live) return;
        const active = (st.active_tasks ?? []).filter((t) => t.model_id);
        if (active.length === 0 && (st.queue_length ?? 0) === 0) {
          setState(null);
          setDismissed(false);
        } else {
          setState({ active, queued: st.queue_length ?? 0 });
        }
      } catch {
        /* offline — hidden */
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 3000);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  if (!state || dismissed) return null;

  return (
    <div className="glass-l2 fixed right-3 top-3 z-[55] w-[min(360px,92vw)] rounded-lg p-3">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-sm font-semibold">Downloads & Queue</h2>
        <span className="rounded border border-status-active/40 bg-status-active/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-status-active">
          {state.active.length} active
        </span>
        {state.queued > 0 && (
          <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase text-ink-muted">
            {state.queued} queued
          </span>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto rounded px-1.5 font-mono text-xs text-ink-faint hover:text-white"
          title="Dismiss (reappears on change)"
        >
          ✕
        </button>
      </div>

      <ul className="mt-2 space-y-2">
        {state.active.map((t, i) => (
          <li key={`${t.model_id}-${t.version_id}-${i}`} className="rounded border border-white/[0.06] p-2">
            <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
              <span className="min-w-0 flex-1 truncate text-ink">
                model {t.model_id} · v{t.version_id}
              </span>
              <span className="text-ink">{t.progress ?? 0}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-white/10">
              <div
                className="h-full rounded-sm bg-gradient-to-r from-primary to-secondary transition-all"
                style={{ width: `${t.progress ?? 0}%` }}
              />
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
              {t.message || 'downloading…'}
            </div>
          </li>
        ))}
      </ul>

      {state.queued > 0 && (
        <p className="mt-2 font-mono text-[10px] text-ink-faint">
          +{state.queued} waiting behind the parallel limit
        </p>
      )}

      <button
        type="button"
        onClick={() => go('queue')}
        className="mt-2 w-full rounded border border-primary/50 bg-primary/20 py-1.5 text-xs font-semibold text-white hover:bg-primary/30"
      >
        View Full Queue →
      </button>
    </div>
  );
}

export function Plugins() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'official'>('all');
  const [catalog, setCatalog] = useState<HubCatalog | null>(null);
  const [live, setLive] = useState(false);
  const [installed, setInstalled] = useState<
    Record<string, { name?: string; version?: string; has_update?: boolean }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [volOpen, setVolOpen] = useState<string | null>(null);
  const [volRows, setVolRows] = useState<
    Array<{ env_var: string; host_path?: string; container_path?: string; description?: string; value?: string }>
  >([]);
  const [volEdits, setVolEdits] = useState<Record<string, string>>({});
  const [volMsg, setVolMsg] = useState<string | null>(null);
  // Update check (moved off the System tab) + GitHub token for private repos.
  const [updates, setUpdates] = useState<{
    core?: { has_update?: boolean; local_version?: string; remote_version?: string };
    plugins?: Array<{ id: string; name: string }>;
    total?: number;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [tokenSaved, setTokenSaved] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setUpdateMsg(null);
    try {
      const { apiGet, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) {
        setUpdateMsg('Backend unreachable.');
        return;
      }
      setUpdates(await apiGet('/updates/check'));
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  const applyCore = async () => {
    setApplying(true);
    setUpdateMsg(null);
    try {
      const { apiPost } = await import('../lib/backend');
      const r = await apiPost<{ ok: boolean; message?: string }>('/updates/core', {});
      setUpdateMsg(r.message ?? (r.ok ? 'Updated.' : 'Update failed.'));
      await check();
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setApplying(false);
    }
  };

  const refreshTokenStatus = async () => {
    try {
      const { apiGet, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) return;
      const r = await apiGet<{ saved?: boolean }>('/plugins/github-token');
      setTokenSaved(Boolean(r.saved));
    } catch {
      /* standalone */
    }
  };

  const saveToken = async () => {
    setTokenMsg('saving…');
    try {
      const { apiPost, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) throw new Error('Backend unreachable.');
      const r = await apiPost<{ ok: boolean; saved?: boolean }>('/plugins/github-token', {
        token: tokenInput,
      });
      setTokenSaved(Boolean(r.saved));
      setTokenInput('');
      setTokenMsg(r.saved ? 'saved to DB + .env' : 'cleared');
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const refreshInstalled = async () => {
    try {
      const { apiGet, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) return;
      const r = await apiGet<{ installed?: Array<{ id: string; name?: string; version?: string; has_update?: boolean }> }>(
        '/plugins',
      );
      const map: Record<string, { name?: string; version?: string; has_update?: boolean }> = {};
      for (const p of r.installed ?? []) map[p.id] = p;
      setInstalled(map);
    } catch {
      /* standalone — hub only */
    }
  };

  useEffect(() => {
    let on = true;
    void (async () => {
      const { catalog: c, live: ok } = await fetchCatalog();
      if (on) {
        setCatalog(c);
        setLive(ok);
      }
    })();
    void refreshInstalled();
    void refreshTokenStatus();
    return () => {
      on = false;
    };
  }, []);

  const runAction = async (
    id: string,
    fn: (api: typeof import('../lib/backend')) => Promise<string>,
  ) => {
    setBusy(id);
    try {
      const api = await import('../lib/backend');
      if (!(await api.backendAvailable())) throw new Error('Backend unreachable — start it to install.');
      const done = await fn(api);
      setMsg((m) => ({ ...m, [id]: done }));
      window.dispatchEvent(new Event('sdcodex:plugins-changed'));
      await refreshInstalled();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: e instanceof Error ? e.message : 'Failed' }));
    } finally {
      setBusy(null);
    }
  };

  const openVolumes = async (id: string) => {
    if (volOpen === id) {
      setVolOpen(null);
      return;
    }
    setVolOpen(id);
    setVolRows([]);
    setVolEdits({});
    setVolMsg(null);
    try {
      const { apiGet, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) throw new Error('Backend unreachable.');
      const r = await apiGet<{ volumes?: typeof volRows }>('/plugins/' + id + '/volumes');
      setVolRows(r.volumes ?? []);
      setVolEdits(Object.fromEntries((r.volumes ?? []).map((v) => [v.env_var, v.value ?? v.host_path ?? ''])));
    } catch (e) {
      setVolMsg(e instanceof Error ? e.message : 'Failed to load volumes');
    }
  };

  const saveVolumes = async (id: string) => {
    setVolMsg('saving…');
    try {
      const { apiPost, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) throw new Error('Backend unreachable.');
      await apiPost('/plugins/' + id + '/volumes', { volumes: volEdits });
      setVolMsg('saved — restart/rebuild to mount volumes');
    } catch (e) {
      setVolMsg(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const list = catalog?.plugins ?? [];
  const shown = list.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div>
      <PageHeader
        title="Plugin Hub"
        subtitle="Extensions and system orchestrator. Installer backend pending — manifests below define the install contract."
        meta={`${list.length} plugins · ${live ? 'live hub catalog' : 'built-in list (hub unreachable)'}${catalog?.core ? ` · core ${catalog.core.version}` : ''}`}
      />
      {catalog?.core && (
        <div className="glass-l1 mt-4 flex flex-wrap items-center gap-3 rounded-lg p-4">
          <div className="min-w-0 flex-1">
            <div className="font-display text-base font-semibold">{catalog.core.name}</div>
            <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{catalog.core.description}</div>
          </div>
          <span className="rounded border border-primary/50 bg-primary/20 px-2 py-0.5 font-mono text-[11px] text-white">
            v{catalog.core.version}
          </span>
        </div>
      )}
      <div className="glass-l1 edge-shimmer mt-4 flex flex-wrap items-center gap-2 rounded-lg p-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search plugins…  ( / )" />
        <FilterPills
          options={[
            { id: 'all', label: 'All' },
            { id: 'official', label: 'Official & verified' },
          ]}
          active={filter}
          onPick={setFilter}
        />
      </div>
      <div className="glass-l1 mt-4 rounded-lg p-4">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-sm font-semibold">Updates</h3>
          {updates && (updates.total ?? 0) > 0 && (
            <span className="rounded border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 font-mono text-[10px] uppercase text-[#fcd34d]">
              {updates.total} available
            </span>
          )}
          <GhostButton className="ml-auto" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Check now'}
          </GhostButton>
        </div>
        {updates?.core && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-white/[0.06] px-2 py-1.5 font-mono text-[11px]">
            <span className="text-ink">Core</span>
            <span className="text-ink-faint">
              v{updates.core.local_version || '?'} → v{updates.core.remote_version || '?'}
            </span>
            {updates.core.has_update ? (
              <PrimaryButton disabled={applying} onClick={() => void applyCore()}>
                {applying ? 'Updating…' : 'Update core'}
              </PrimaryButton>
            ) : (
              <span className="text-status-active">up to date</span>
            )}
          </div>
        )}
        {(updates?.plugins ?? []).length > 0 && (
          <div className="mt-2 font-mono text-[11px] text-ink-muted">
            Plugin updates: {(updates?.plugins ?? []).map((p) => p.name ?? p.id).join(', ')} — use
            the Update button on each card below.
          </div>
        )}
        {updateMsg && <p className="mt-2 font-mono text-[11px] text-ink-muted">{updateMsg}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
          <span className="font-mono text-[11px] text-ink-muted">
            GitHub token {tokenSaved == null ? '' : tokenSaved ? '(saved ✓)' : '(not set)'}
          </span>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="ghp_… (private plugin repos)"
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-2 py-1.5 font-mono text-[11px] outline-none placeholder:text-ink-faint focus:border-primary"
          />
          <GhostButton onClick={() => void saveToken()}>Save token</GhostButton>
          {tokenMsg && <span className="font-mono text-[10px] text-ink-faint">{tokenMsg}</span>}
        </div>
      </div>
      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shown.map((p) => {
          const inst = installed[p.id];
          return (
            <article key={p.id} className="glass-l1 rounded-lg p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-base font-semibold">{p.name}</h2>
                <span className="flex items-center gap-1.5">
                  {inst && (
                    <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
                      installed{inst.version ? ` v${inst.version}` : ''}
                    </span>
                  )}
                  <span className="rounded border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase text-ink-muted">
                    v{p.version}
                  </span>
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">{p.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a
                  href={p.repository}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-secondary hover:underline"
                >
                  {p.repository}
                </a>
                {!inst ? (
                  <GhostButton
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction(p.id, async (api) => {
                        const r = await api.apiPost<{ ok: boolean; plugin?: { name?: string }; error?: string }>(
                          '/plugins/install',
                          { repo_url: p.repository },
                        );
                        return `installed ${r.plugin?.name ?? p.id} — set volumes below, then restart/rebuild to mount`;
                      })
                    }
                  >
                    {busy === p.id ? 'Installing…' : 'Install'}
                  </GhostButton>
                ) : (
                  <>
                    <GhostButton disabled={busy !== null} onClick={() => void openVolumes(p.id)}>
                      {volOpen === p.id ? 'Hide volumes' : 'Volumes'}
                    </GhostButton>
                    {inst.has_update && (
                      <GhostButton
                        disabled={busy !== null}
                        onClick={() =>
                          void runAction(p.id, async (api) => {
                            const r = await api.apiPost<{ ok: boolean; message?: string }>(
                              `/plugins/${p.id}/update`,
                              {},
                            );
                            return r.message ?? (r.ok ? 'Updated.' : 'Update failed.');
                          })
                        }
                      >
                        {busy === p.id ? 'Updating…' : 'Update'}
                      </GhostButton>
                    )}
                    <GhostButton
                      disabled={busy !== null}
                      onClick={() =>
                        void runAction(p.id, async (api) => {
                          const r = await api.apiDelete<{ ok: boolean; message?: string }>(
                            `/plugins/${p.id}`,
                          );
                          if (volOpen === p.id) setVolOpen(null);
                          return r.message ?? (r.ok ? 'Uninstalled.' : 'Uninstall failed.');
                        })
                      }
                    >
                      {busy === p.id ? 'Working…' : 'Uninstall'}
                    </GhostButton>
                  </>
                )}
              </div>
              {volOpen === p.id && inst && (
                <div className="mt-3 rounded-lg border border-white/[0.06] bg-obsidian-lowest/60 p-3">
                  <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                    Volumes → .env + compose override
                  </div>
                  {volRows.length === 0 && !volMsg && (
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">loading…</p>
                  )}
                  {volRows.map((v) => (
                    <div key={v.env_var} className="mt-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold text-secondary">{v.env_var}</span>
                        <span className="font-mono text-[10px] text-ink-faint">→ {v.container_path}</span>
                      </div>
                      {v.description && (
                        <p className="font-mono text-[10px] text-ink-faint">{v.description}</p>
                      )}
                      <input
                        value={volEdits[v.env_var] ?? ''}
                        onChange={(e) => setVolEdits((ed) => ({ ...ed, [v.env_var]: e.target.value }))}
                        placeholder={v.host_path ?? './data'}
                        className="mt-1 w-full rounded border border-white/10 bg-obsidian-lowest px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
                      />
                    </div>
                  ))}
                  {volRows.length > 0 && (
                    <GhostButton className="mt-2" onClick={() => void saveVolumes(p.id)}>
                      Save volumes
                    </GhostButton>
                  )}
                  {volMsg && <p className="mt-1 font-mono text-[10px] text-ink-faint">{volMsg}</p>}
                </div>
              )}
              {msg[p.id] && (
                <p className="mt-1 font-mono text-[10px] text-ink-faint">{msg[p.id]}</p>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
