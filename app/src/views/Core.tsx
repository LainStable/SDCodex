import { useEffect, useRef, useState } from 'react';
import {
  DangerButton,
  GhostButton,
  PageHeader,
  PrimaryButton,
  Stat,
} from '../components/chrome';
import { isPaused, setPaused, type QueueItem } from '../lib/queue';
import { bootstrapUser, startSession, verifyPassword, type Profile } from '../lib/auth';
import { adoptServerUser, fetchPublicProviders, type ServerAuthState } from '../lib/auth';
import { apiPost, mirrorAuth } from '../lib/backend';
import { fetchCatalog, type HubCatalog } from '../lib/plugins';
import { loadTheme, saveTheme, THEMES } from '../lib/themes';
import { getScanState, subscribeScanState, type LocalScanState } from '../lib/scanstate';

/** Blocking auth gate (mirrors OldCode bootstrap + login). No session, no app:
    first-ever user sets a password and becomes admin; returning users sign in. */
export function BootstrapCard({
  existing,
  serverMode,
  serverBootstrap,
  onServerChanged,
  onDone,
}: {
  existing: Profile | null;
  /** When true, the backend verifies (fresh origins with no local hash). */
  serverMode: boolean;
  /** Server user count (only meaningful in serverMode). */
  serverBootstrap: boolean;
  /** Called when the server disagrees (e.g. users appeared) so App re-checks. */
  onServerChanged?: () => void;
  onDone: (p: Profile) => void;
}) {
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<Array<{ id: number; name: string; host: string }>>([]);
  // First-run accounts pick their UI theme here; it is stored on the user row.
  const [themeSlug, setThemeSlug] = useState<string>(() => loadTheme());
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
            theme: themeSlug,
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
      const created = await bootstrapUser(loginName, display, password, themeSlug);
      try {
        await mirrorAuth('bootstrap', {
          username: loginName,
          displayName: display,
          password,
          theme: themeSlug,
        });
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
      <div className="flex flex-col items-center px-2 pb-1">
        <img src="/codex.svg" alt="SDCodex" className="h-40 w-full object-contain" />
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
        {isCreate && (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
              Theme
            </span>
            <select
              value={themeSlug}
              onChange={(e) => {
                // Apply immediately so the gate itself previews the theme.
                saveTheme(e.target.value);
                setThemeSlug(loadTheme());
              }}
              className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none focus:border-primary"
            >
              {THEMES.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name} · {t.mode === 'dark' ? 'Dark' : 'Light'}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="font-mono text-[11px] text-status-alert">{error}</p>}
        <PrimaryButton
          className="mx-6"
          disabled={busy || !username.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Working…' : !isCreate ? 'Sign in' : 'Create administrator'}
        </PrimaryButton>
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

const STATUS_STYLE: Record<string, string> = {
  queued: 'border-white/15 bg-white/5 text-ink-muted',
  downloading: 'border-secondary/40 bg-secondary/10 text-[#22d3ee]',
  done: 'border-status-active/40 bg-status-active/10 text-status-active',
  failed: 'border-status-alert/40 bg-status-alert/10 text-[#f87171]',
  cancelled: 'border-white/15 bg-white/5 text-ink-faint',
  paused: 'border-status-warning/40 bg-status-warning/10 text-[#fbbf24]',
};

/** One server-side task row from /downloads/status. */
type ServerTask = {
  type?: string;
  model_id?: number;
  version_id?: number;
  status?: string;
  progress?: number;
  message?: string;
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
    active: ServerTask[];
    queuedTasks: ServerTask[];
    pausedTasks: ServerTask[];
    history: ServerTask[];
    queued: number;
    max: number;
    reachable: boolean;
  }>({
    active: [],
    queuedTasks: [],
    pausedTasks: [],
    history: [],
    queued: 0,
    max: 1,
    reachable: false,
  });
  const active = items.filter((i) => i.status !== 'done');
  // Staged items that never reached the worker (backend restarted, POST failed
  // while offline) are re-submitted once; the ref prevents retry loops.
  const revived = useRef<Set<string>>(new Set());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const togglePaused = () => {
    const next = !paused;
    setPaused(next);
    setPausedState(next);
    void (async () => {
      try {
        const { apiPost, backendAvailable } = await import('../lib/backend');
        if (!(await backendAvailable())) return;
        await apiPost(next ? '/downloads/pause-all' : '/downloads/start-all', { force: true });
      } catch {
        /* standalone — local flag still gates the list */
      }
    })();
  };

  // Per-item control. Start always asks the worker to run now (`force`), so a
  // download can jump the parallel limit; pause parks it without losing the
  // task definition.
  const controlTask = async (item: QueueItem, action: 'pause' | 'start') => {
    if (!item.modelId || !item.versionId) return;
    try {
      const { apiPost } = await import('../lib/backend');
      await apiPost(action === 'pause' ? '/downloads/pause' : '/downloads/start', {
        modelId: item.modelId,
        versionId: item.versionId,
        force: true,
      });
      if (action === 'start') {
        revived.current.delete(`${item.modelId}:${item.versionId}`);
      }
    } catch {
      /* poll refreshes; a stale row self-heals on the next tick */
    }
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
            active_tasks?: ServerTask[];
            queued_tasks?: ServerTask[];
            paused_tasks?: ServerTask[];
            recent_history?: ServerTask[];
            history?: ServerTask[];
            queue_length?: number;
            max_parallel?: number;
          }>('/downloads/status');
          if (!live) return;
          const activeTasks = st.active_tasks ?? [];
          const queuedTasks = st.queued_tasks ?? [];
          const pausedTasks = st.paused_tasks ?? [];
          const historyTasks = st.history ?? st.recent_history ?? [];
          setServer({
            active: activeTasks,
            queuedTasks,
            pausedTasks,
            history: historyTasks,
            queued: st.queue_length ?? 0,
            max: st.max_parallel ?? 1,
            reachable: true,
          });
          // Re-stage staged rows the worker never saw (one attempt each). A
          // key found in history already finished, so it is not retried.
          const known = new Set(
            [...activeTasks, ...queuedTasks, ...pausedTasks, ...historyTasks].map(
              (t) => `${t.model_id}:${t.version_id}`,
            ),
          );
          for (const item of itemsRef.current) {
            // Only rows still waiting locally: a finished or failed row must
            // not be retried behind the user's back.
            if (item.status !== 'queued' || !item.modelId || !item.versionId) continue;
            const key = `${item.modelId}:${item.versionId}`;
            if (known.has(key) || revived.current.has(key)) continue;
            revived.current.add(key);
            try {
              await apiPost('/downloads', {
                modelId: item.modelId,
                versionId: item.versionId,
              });
            } catch {
              revived.current.delete(key);
            }
          }
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
          {items.map((i) => {
            const match = (list: ServerTask[]) =>
              list.find((entry) => entry.model_id === i.modelId && entry.version_id === i.versionId);
            const task = match(server.active) ?? match(server.pausedTasks) ?? match(server.queuedTasks);
            const finished = match(server.history);
            const status =
              {
                completed: 'done',
                running: 'downloading',
                failed: 'failed',
                cancelled: 'cancelled',
                queued: 'queued',
                paused: 'paused',
              }[(task ?? finished)?.status ?? ''] ?? (paused ? 'paused' : i.status);
            const canPause =
              server.reachable && (status === 'queued' || status === 'downloading');
            const canStart =
              server.reachable && ['paused', 'failed', 'cancelled', 'queued', 'staged'].includes(status);
            return (
              <li key={i.id} className="glass-l1 rounded-lg p-3">
                <div className="flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{i.name}</div>
                    <div className="truncate font-mono text-[11px] text-ink-muted">
                      {i.detail}
                    </div>
                  </div>
                  <span
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase ${STATUS_STYLE[status] ?? STATUS_STYLE.queued}`}
                  >
                    {paused && status !== 'done' && status !== 'downloading' ? 'paused' : status}
                  </span>
                  <span className="font-mono text-[11px] text-ink">
                    {(task ?? finished)?.progress != null
                      ? `${(task ?? finished)!.progress}%`
                      : i.progress != null
                        ? `${i.progress}%`
                        : 'staged'}
                  </span>
                  {canPause && (
                    <button
                      type="button"
                      title="Pause download"
                      onClick={() => void controlTask(i, 'pause')}
                      className="rounded border border-white/15 px-2 py-0.5 font-mono text-xs text-ink-faint hover:border-status-warning/60 hover:text-[#fbbf24]"
                    >
                      ❙❙
                    </button>
                  )}
                  {canStart && (
                    <button
                      type="button"
                      title={status === 'queued' ? 'Start now (past the parallel limit)' : 'Start download'}
                      onClick={() => void controlTask(i, 'start')}
                      className="rounded border border-white/15 px-2 py-0.5 font-mono text-xs text-ink-faint hover:border-status-active/60 hover:text-status-active"
                    >
                      ▶
                    </button>
                  )}
                  <button
                    type="button"
                    title="Remove from queue"
                    onClick={() => {
                      // Tell the worker too, so a parked (paused) task does
                      // not outlive the row the user just deleted.
                      if (i.modelId && i.versionId) {
                        void (async () => {
                          try {
                            const { apiPost } = await import('../lib/backend');
                            await apiPost('/downloads/cancel', {
                              modelId: i.modelId,
                              versionId: i.versionId,
                            });
                          } catch {
                            /* offline — local row still goes away */
                          }
                        })();
                      }
                      onRemove(i.id);
                    }}
                    className="rounded border border-white/15 px-2 py-0.5 font-mono text-xs text-ink-faint hover:border-status-alert/50 hover:text-[#f87171]"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-white/10">
                  <div
                    className="h-full rounded-sm bg-gradient-to-r from-primary to-secondary transition-all"
                    style={{ width: `${(task ?? finished)?.progress ?? i.progress ?? 0}%` }}
                  />
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                  {(task ?? finished)?.message ||
                    (server.reachable
                      ? 'Waiting for worker status.'
                      : 'Hash status unavailable while the backend is offline.')}
                </div>
              </li>
            );
          })}
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
    <div className="glass-l2 rounded-lg p-3">
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

/** Floating task panel (bottom right, all pages). Plugins that declare a
    ``task_status`` endpoint report long-running work — batch renames, caption
    batches — so this keeps their progress visible while the user browses
    elsewhere in the app. */
export function PluginTaskFloat({
  onOpen,
}: {
  onOpen: (pluginId: string, page: string) => void;
}) {
  type PluginTask = {
    pluginId: string;
    pluginName: string;
    page: string;
    state: string;
    current: number;
    total: number;
    detail: string;
    message: string;
    startedAt: number;
  };
  const [tasks, setTasks] = useState<PluginTask[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const { apiGet, backendAvailable } = await import('../lib/backend');
        if (!(await backendAvailable())) return;
        const st = await apiGet<{ tasks?: PluginTask[] }>('/plugin-tasks');
        if (!live) return;
        const running = (st.tasks ?? []).filter((t) => t.state === 'running' || t.state === 'cancelling');
        setTasks(running);
        if (running.length === 0) setDismissed(false);
        setNow(Date.now() / 1000);
      } catch {
        /* offline — keep the last view */
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 2000);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  if (tasks.length === 0 || dismissed) return null;

  const elapsed = (task: PluginTask) => {
    if (!task.startedAt) return '';
    const seconds = Math.max(0, Math.round(now - task.startedAt));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  };

  return (
    <div className="glass-l2 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-sm font-semibold">Plugin Tasks</h2>
        <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-primary">
          {tasks.length} running
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto rounded px-1.5 font-mono text-xs text-ink-faint hover:text-white"
          title="Dismiss (reappears when a new task starts)"
        >
          ✕
        </button>
      </div>

      <ul className="mt-2 space-y-2">
        {tasks.map((task) => {
          const percent = task.total > 0 ? Math.min(100, (task.current / task.total) * 100) : 0;
          return (
            <li key={task.pluginId} className="rounded border border-white/[0.06] p-2">
              <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="min-w-0 flex-1 truncate text-ink">{task.pluginName}</span>
                <span className="shrink-0 text-ink-muted">
                  {task.current}/{task.total || '?'}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-obsidian-high/60">
                <div
                  className={`h-full rounded-sm bg-gradient-to-r from-primary to-secondary transition-all ${
                    task.state === 'cancelling' ? 'animate-pulse' : ''
                  }`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-faint">
                <span className="min-w-0 flex-1 truncate">
                  {task.message || 'working…'}
                  {task.detail ? ` · ${task.detail}` : ''}
                </span>
                <span className="shrink-0">{elapsed(task)}</span>
              </div>
              <button
                type="button"
                onClick={() => onOpen(task.pluginId, task.page)}
                className="mt-2 w-full rounded border border-white/15 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted hover:bg-white/5 hover:text-white"
              >
                Open {task.pluginName} →
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Floating scan panel (bottom right, stacked under plugin tasks). Server
    scans run inside the download worker and are polled from
    /downloads/status; browser (folder-linked) scans report through
    lib/scanstate. Both keep progress visible while the user browses. */
export function ScanFloat({ onOpen }: { onOpen: () => void }) {
  type ServerScan = { percent: number; message: string; queued: number; startedAt: number };
  const [local, setLocal] = useState<LocalScanState | null>(getScanState);
  const [server, setServer] = useState<ServerScan | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [dismissed, setDismissed] = useState(false);
  const serverStart = useRef(0);
  const lastRun = useRef('');

  useEffect(
    () =>
      subscribeScanState((next) => {
        setLocal(next);
        setNow(Date.now() / 1000);
      }),
    [],
  );

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const { apiGet, backendAvailable } = await import('../lib/backend');
        if (!(await backendAvailable())) {
          if (live) setServer(null);
          return;
        }
        const st = await apiGet<{
          active_tasks?: Array<{ type?: string; progress?: number; message?: string }>;
          scan_queued?: number;
        }>('/downloads/status');
        if (!live) return;
        const scan = (st.active_tasks ?? []).find((t) => t.type === 'scan');
        if (!scan) {
          serverStart.current = 0;
          setServer(null);
          return;
        }
        if (!serverStart.current) serverStart.current = Date.now() / 1000;
        setServer({
          percent: Math.max(0, Math.min(100, Number(scan.progress ?? 0))),
          message: scan.message || 'Scanning…',
          queued: st.scan_queued ?? 0,
          startedAt: serverStart.current,
        });
        setNow(Date.now() / 1000);
      } catch {
        if (live) setServer(null);
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 2000);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  const view = local
    ? {
        run: `local-${local.startedAt}`,
        label: local.label,
        percent: local.total > 0 ? (local.current / local.total) * 100 : 0,
        count: `${local.current}/${local.total || '?'}`,
        message: local.message,
        queued: 0,
        startedAt: local.startedAt,
      }
    : server
      ? {
          run: `server-${server.startedAt}`,
          label: 'all folders',
          percent: server.percent,
          count: `${Math.round(server.percent)}%`,
          message: server.message,
          queued: server.queued,
          startedAt: server.startedAt,
        }
      : null;

  useEffect(() => {
    if (!view || view.run === lastRun.current) return;
    lastRun.current = view.run;
    setDismissed(false);
    // Re-run only when a different scan starts, not on every progress tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.run]);

  if (!view || dismissed) return null;

  const seconds = Math.max(0, Math.round(now - view.startedAt));
  const elapsed = view.startedAt
    ? seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
    : '';

  return (
    <div className="glass-l2 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-sm font-semibold">Model Scan</h2>
        <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-primary">
          {view.count}
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto rounded px-1.5 font-mono text-xs text-ink-faint hover:text-white"
          title="Dismiss (reappears when a new scan starts)"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 rounded border border-white/[0.06] p-2">
        <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
          <span className="min-w-0 flex-1 truncate text-ink">Scanning {view.label}</span>
          <span className="shrink-0 text-ink-muted">{Math.round(view.percent)}%</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-obsidian-high/60">
          <div
            className="h-full rounded-sm bg-gradient-to-r from-primary to-secondary transition-all"
            style={{ width: `${Math.max(2, view.percent)}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-faint">
          <span className="min-w-0 flex-1 truncate">
            {view.message}
            {view.queued > 0 ? ` · ${view.queued} queued` : ''}
          </span>
          <span className="shrink-0">{elapsed}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-2 w-full rounded border border-white/15 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted hover:bg-white/5 hover:text-white"
      >
        Open Model dirs →
      </button>
    </div>
  );
}

/** Small indeterminate progress bar for git operations (replaces raw output). */
function ProgressBar() {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-primary to-secondary" />
      <style>{'@keyframes slide { 0% { margin-left: -33%; } 100% { margin-left: 100%; } }'}</style>
    </div>
  );
}

/* Step labels mirror the real backend phases (updater.update_core writes the
   git-pull lines, rebuilder._rebuild_container writes the image/build/swap
   lines, swap_helper writes the helper: lines) so each label describes what
   the log underneath is actually doing. */
const SELF_UPDATE_DOCKER_STEPS: Array<{ label: string; match: RegExp }> = [
  { label: 'Pulling code from GitHub', match: /Core update requested|Running git pull|^\s*\d{4}-.*\bgit:/im },
  { label: 'Updating plugins', match: /Plugin updates:/ },
  { label: 'Building new image', match: /image build started|^\s*\d{4}-.*\bbuild:/im },
  { label: 'Resolving container config', match: /\b(binds|ports):/i },
  { label: 'Creating new container', match: /creating sibling|removed stale|sibling create/i },
  { label: 'Starting new container', match: /sibling joined network|sibling started, waiting for health/i },
  { label: 'Stopping old container', match: /swap delegated|helper: stopping old/i },
  { label: 'Swapping container', match: /helper: recreating sibling|rename (old|new)/i },
  { label: 'Starting updated container', match: /helper: final started|swap done/i },
];

const SELF_UPDATE_LOCAL_STEPS: Array<{ label: string; match: RegExp }> = [
  { label: 'Pulling code from GitHub', match: /Core update requested|Running git pull|^.*\bgit:/i },
  { label: 'Updating plugins', match: /Plugin updates:/ },
  { label: 'Restarting app', match: /local restart started|Restarting backend/i },
  { label: 'Waiting for app', match: /swap done|answers health/i },
];

/** Derive per-step status from the rebuild log so the indicator dot can
    change colour as each phase starts/finishes. */
function selfUpdateProgress(lines: string[], isLocal: boolean): {
  steps: string[];
  active: number;
  failed: boolean;
} {
  const steps = (isLocal ? SELF_UPDATE_LOCAL_STEPS : SELF_UPDATE_DOCKER_STEPS).map((s) => s.label);
  const matchers = (isLocal ? SELF_UPDATE_LOCAL_STEPS : SELF_UPDATE_DOCKER_STEPS).map((s) => s.match);
  const joined = lines.join('\n');
  // "HTTPS pull failed; retrying…" is a routine retry, not a failure.
  const failed = /BUILD ERROR|rebuild exception|ABORT:|Update failed|Git pull failed(?!; retrying)|sibling create failed|swap helper launch failed|never healthy/i.test(joined);
  let active = -1;
  matchers.forEach((re, i) => {
    if (re.test(joined)) active = i;
  });
  const done = /swap done/i.test(joined);
  if (done) active = steps.length;
  return { steps, active, failed };
}

export function Plugins() {
  const [catalog, setCatalog] = useState<HubCatalog | null>(null);
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
    rebuild_required?: boolean;
    rebuild?: { can_rebuild?: boolean; mode?: string; install_mode?: string; runtime_mode?: string };
    install_mode?: { mode: 'docker' | 'local'; runtime_mode: 'docker' | 'local'; matches_runtime: boolean };
    total?: number;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildLog, setRebuildLog] = useState<string[]>([]);
  const [showRebuildLog, setShowRebuildLog] = useState(false);
  // The updater log is secondary detail — collapsed until the user asks for it.
  const [logOpen, setLogOpen] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const rebuildLogEndRef = useRef<HTMLDivElement>(null);
  const updateUnavailable = updates?.rebuild?.can_rebuild === false;

  useEffect(() => {
    if (showRebuildLog) rebuildLogEndRef.current?.scrollIntoView({ block: 'end' });
  }, [rebuildLog, showRebuildLog]);

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

  /** Single "Update" flow: pull the updated code first, then rebuild.
      Replaces the old separate Update-core / Rebuild-now buttons. */
  const updateAll = async () => {
    setApplying(true);
    setUpdateMsg(null);
    setRebuildLog([]);
    setShowRebuildLog(true);
    setLogOpen(false);
    let polling = true;
    const pollLogs = async () => {
      while (polling) {
        try {
          const { apiGet } = await import('../lib/backend');
          const result = await apiGet<{ lines?: string[] }>('/system/rebuild/log');
          if (result.lines) setRebuildLog(result.lines);
        } catch {
          /* A transient poll failure should not interrupt the update request. */
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    };
    const logPolling = pollLogs();
    try {
      const { apiPost } = await import('../lib/backend');
      // Core + every installed plugin are pulled server-side; allow well past
      // the default request ceiling when several remotes are slow.
      const r = await apiPost<{ ok: boolean; message?: string }>('/updates/core', {}, 30 * 60_000);
      if (!r.ok) {
        setUpdateMsg(r.message ?? 'Update failed.');
        return;
      }
      setUpdateMsg(r.message ?? 'Updated.');
      await check();
      await refreshInstalled();
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : 'Update failed');
      return;
    } finally {
      polling = false;
      await logPolling;
      setApplying(false);
    }
    await rebuild();
  };

  const rebuild = async () => {
    setRebuilding(true);
    setShowRebuildLog(true);
    setLogOpen(false);
    setUpdateMsg(null);
    // Docker keeps the old app answering health until replacement; local
    // mode restarts the backend process in place.
    const isLocal = updates?.rebuild?.mode === 'local';
    let preVersion = '';
    let backendWentDown = false;
    try {
      const { apiGet } = await import('../lib/backend');
      try {
        const h = await apiGet<{ version?: string }>('/health');
        preVersion = h.version ?? '';
      } catch {
        /* ignore */
      }
      const { apiPost, resetBackendProbe } = await import('../lib/backend');
      const r = await apiPost<{ ok: boolean; message?: string }>('/system/rebuild', {});
      if (!r.ok) throw new Error(r.message ?? 'Rebuild refused.');
      setUpdateMsg(r.message ?? (isLocal ? 'Restarting…' : 'Rebuilding…'));
      for (let i = 0; i < 180; i++) {
        await new Promise((res) => setTimeout(res, isLocal ? 2000 : 10000));
        try {
          const lj = await apiGet<{ lines?: string[] }>('/system/rebuild/log');
          if (lj.lines) {
            setRebuildLog(lj.lines);
            if (!isLocal && lj.lines.some((line) => line.includes('swap done'))) {
              window.location.reload();
              return;
            }
          }
        } catch {
          /* backend going down — keep last lines */
        }
        try {
          resetBackendProbe();
          const h = await fetch('/api/health', { cache: 'no-store' });
          if (!h.ok) backendWentDown = true;
          if (h.ok) {
            const j = (await h.json().catch(() => ({}))) as { version?: string };
            if ((j.version && preVersion && j.version !== preVersion) || backendWentDown) {
              window.location.reload();
              return;
            }
            if (!preVersion && i > 2) {
              window.location.reload();
              return;
            }
          }
        } catch {
          /* still down */
        }
      }
      setUpdateMsg('Still waiting — reload manually once the app is back.');
    } catch (e) {
      setUpdateMsg(e instanceof Error ? e.message : 'Rebuild failed');
    } finally {
      setRebuilding(false);
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
    const refreshUpdates = () => void check();
    window.addEventListener('sdcodex:install-mode-changed', refreshUpdates);
    void (async () => {
      const { catalog: c } = await fetchCatalog();
      if (on) setCatalog(c);
    })();
    void refreshInstalled();
    void check();
    return () => {
      on = false;
      window.removeEventListener('sdcodex:install-mode-changed', refreshUpdates);
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
      await fn(api);
      // Git chatter stays out of the UI — a short confirmation instead.
      setMsg((m) => ({ ...m, [id]: 'Done.' }));
      window.dispatchEvent(new Event('sdcodex:plugins-changed'));
      await refreshInstalled();
      await check();
    } catch (e) {
      const text = e instanceof Error ? e.message : 'Failed';
      setMsg((m) => ({ ...m, [id]: text.length > 160 ? text.slice(0, 160) + '…' : text }));
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
  const core = catalog?.core;
  const coreNeedsUpdate = Boolean(updates?.core?.has_update);

  return (
    <div>
      <PageHeader title="Plugin Hub" subtitle="Install and manage application extensions." />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <GhostButton disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check now'}
        </GhostButton>
        <GhostButton
          disabled={checking || applying || rebuilding || updateUnavailable}
          onClick={() => void updateAll()}
          className={coreNeedsUpdate ? 'border-status-warning/50 bg-status-warning/15 text-[#fcd34d] hover:bg-status-warning/25' : updates?.plugins && updates.plugins.length > 0 ? 'border-secondary/50 bg-secondary/15 text-[#22d3ee] hover:bg-secondary/25' : ''}
        >
          {applying || rebuilding ? 'Updating…' : 'Update'}
        </GhostButton>
        {applying && (
          <div className="min-w-40 flex-1">
            <ProgressBar />
          </div>
        )}
      </div>
      {updates?.rebuild?.mode === 'mismatch' && (
        <p role="alert" className="mt-2 font-mono text-[11px] text-[#fcd34d]">
          Selected install mode ({updates.rebuild.install_mode}) differs from the running app
          ({updates.rebuild.runtime_mode}). Restart it externally in the selected mode before updating.
        </p>
      )}
      {updates?.rebuild?.mode === 'docker-nosocket' && (
        <p role="status" className="mt-2 font-mono text-[11px] text-ink-faint">
          Docker self-update is unavailable in this setup. Update or restart the app from the host.
        </p>
      )}
      {updates?.rebuild_required && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-status-warning/30 bg-status-warning/[0.07] px-2 py-1.5 font-mono text-[11px]">
          <span className="text-[#fcd34d]">Restart required</span>
          <span className="text-ink-faint">
            {updates.rebuild?.mode === 'docker'
              ? 'press Update above (pulls latest code, then rebuilds)'
              : updates.rebuild?.mode === 'local'
                ? 'press Update above (pulls latest code, then restarts)'
                : 'see the deployment notice above'}
          </span>
        </div>
      )}
      {updateMsg && <p className="mt-2 font-mono text-[11px] text-ink-muted">{updateMsg}</p>}
      {showRebuildLog &&
        (() => {
          const isLocal = updates?.rebuild?.mode === 'local';
          const { steps, active, failed } = selfUpdateProgress(rebuildLog, isLocal);
          const running = applying || rebuilding;
          const finished = active >= steps.length;
          const statusText = finished
            ? 'Update complete — reloading…'
            : failed
              ? `Failed at ${steps[Math.max(0, active)]} — see log`
              : running && active >= 0
                ? `${steps[active]}…`
                : running
                  ? 'Preparing…'
                  : 'Preparing…';
          return (
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4">
              <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-[#2c2e33]">
                <div className="flex items-center justify-between px-5 py-4">
                  <img src="/codex.svg" alt="SDCodex" className="h-40 w-full object-fill" />
                  <button
                    type="button"
                    onClick={() => setShowRebuildLog(false)}
                    aria-label="Close self-update dialog"
                    className="text-2xl leading-none text-ink-faint hover:text-white"
                  >
                    ✕
                  </button>
                </div>
                <div className="px-5 py-4">
                  <ol className="flex flex-col gap-2.5">
                    {steps.map((label, i) => {
                      const done = finished || i < active;
                      const current = !finished && i === active;
                      const dot = failed && current
                        ? 'bg-status-alert'
                        : done
                          ? 'bg-status-active'
                          : current
                            ? 'bg-[#5b5bd6] animate-pulse'
                            : 'bg-[#5f636e]';
                      return (
                        <li key={label} className="flex items-center gap-3">
                          <span className={`h-3 w-3 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                          <span className={`text-[15px] ${done || current ? 'text-white' : 'text-[#c9cdd6]'}`}>
                            {label}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  <button
                    type="button"
                    onClick={() => setLogOpen((open) => !open)}
                    aria-expanded={logOpen}
                    className="mt-5 flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-left text-[15px] font-semibold text-white hover:text-[#c9d1d9]"
                  >
                    <span>Updater log</span>
                    <span
                      aria-hidden="true"
                      className={`shrink-0 text-xs text-[#8b93a5] transition-transform ${logOpen ? 'rotate-90' : ''}`}
                    >
                      ▶
                    </span>
                  </button>
                  {logOpen && (
                    <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-[#0b1020] p-4 font-mono text-[13px] leading-relaxed text-[#c9d1d9]">
                      {rebuildLog.length === 0 ? (
                        <p className="text-[#8b93a5]">
                          {applying
                            ? 'waiting for git pull output…'
                            : isLocal
                              ? 'waiting for the app to restart…'
                              : 'waiting for build output…'}
                        </p>
                      ) : (
                        rebuildLog.map((l, i) => (
                          <div key={i} className="break-words">
                            {l}
                          </div>
                        ))
                      )}
                      <div ref={rebuildLogEndRef} />
                    </div>
                  )}
                  <p className="mt-3 text-[14px] text-[#8b93a5]">{statusText}</p>
                </div>
                <div className="flex justify-end px-5 py-3">
                  <button
                    type="button"
                    onClick={() => setShowRebuildLog(false)}
                    className="rounded-lg bg-[#3b4a63] px-6 py-2 text-sm font-semibold text-white hover:bg-[#4a5a75]"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {core && (
          <article
            className={`glass-l1 rounded-lg p-4 ${
              coreNeedsUpdate ? 'border-status-warning/50 ring-1 ring-inset ring-status-warning/30' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold">{core.name}</h2>
              <span className="flex items-center gap-1.5">
                <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
                  installed{updates?.core?.local_version ? ` v${updates.core.local_version}` : ''}
                </span>
                {coreNeedsUpdate ? (
                  <span className="rounded border border-status-warning/50 bg-status-warning/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-[#fcd34d]">
                    update → v{updates?.core?.remote_version || core.version}
                  </span>
                ) : (
                  <span className="rounded border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase text-ink-muted">
                    v{core.version}
                  </span>
                )}
              </span>
            </div>
          </article>
        )}
        {list.map((p) => {
          const inst = installed[p.id];
          const needsUpdate = Boolean(inst?.has_update);
          return (
            <article
              key={p.id}
              className={`glass-l1 rounded-lg p-4 ${
                needsUpdate ? 'border-status-warning/50 ring-1 ring-inset ring-status-warning/30' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-base font-semibold">{p.name}</h2>
                <span className="flex items-center gap-1.5">
                  {inst && (
                    <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
                      installed{inst.version ? ` v${inst.version}` : ''}
                    </span>
                  )}
                  {needsUpdate ? (
                    <span className="rounded border border-status-warning/50 bg-status-warning/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-[#fcd34d]">
                      update → v{p.version}
                    </span>
                  ) : (
                    <span className="rounded border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase text-ink-muted">
                      v{p.version}
                    </span>
                  )}
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
                        return `installed ${r.plugin?.name ?? p.id} — ${
                          updates?.install_mode?.mode === 'local'
                            ? 'restart the local app to load it'
                            : 'configure volumes, then restart/rebuild to mount them'
                        }`;
                      })
                    }
                  >
                    {busy === p.id ? 'Installing…' : 'Install'}
                  </GhostButton>
                ) : (
                  <>
                    {updates?.install_mode?.mode === 'docker' && (
                      <GhostButton disabled={busy !== null} onClick={() => void openVolumes(p.id)}>
                        {volOpen === p.id ? 'Hide volumes' : 'Volumes'}
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
              {volOpen === p.id && inst && updates?.install_mode?.mode === 'docker' && (
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
              {busy === p.id && (
                <div className="mt-2">
                  <ProgressBar />
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
