import { useState } from 'react';
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
import { adoptServerUser, type ServerAuthState } from '../lib/auth';
import { apiPost, mirrorAuth } from '../lib/backend';

const PLUGINS = [
  {
    id: 'gallery',
    name: 'SDCodex Gallery',
    desc: 'Disk-backed media gallery. Scans folders, reads captions and ComfyUI workflows from image metadata.',
    repo: 'https://github.com/LainStable/SDCodex-Gallery',
  },
  {
    id: 'gallery-dl',
    name: 'GalleryDL & Tools',
    desc: 'Background gallery-dl and yt-dlp tasks, quick downloads, kiosks, OAuth config.',
    repo: 'https://github.com/LainStable/SDCodex-GalleryDL',
  },
  {
    id: 'rembg',
    name: 'RemBG Background Tools',
    desc: 'Background removal, replacement, and batch processing powered by BiRefNet.',
    repo: 'https://github.com/LainStable/SDCodex-RemBG',
  },
  {
    id: 'comfy-caption',
    name: 'ComfyUI Captioning',
    desc: 'Auto-captioning with vision LLMs and JoyCaption, plus ComfyUI workflow nodes.',
    repo: 'https://github.com/LainStable/SDCodex-ComfyCaption',
  },
];

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

  const submit = async () => {
    setError(null);
    if (existing) {
      if (!password) {
        setError('Enter your password.');
        return;
      }
      setBusy(true);
      try {
        if (serverMode && !existing.passwordHash) {
          // Fresh origin: no local hash — verify against the backend directly.
          const r = await apiPost<{ ok: boolean; user: ServerAuthState['user'] }>('/auth/login', {
            username: existing.username,
            password,
          });
          const adopted = adoptServerUser(r.user);
          if (!adopted) throw new Error('Login failed');
          startSession();
          onDone(adopted);
          return;
        }
        const ok = await verifyPassword(password, existing.passwordHash);
        if (!ok) {
          setError('Wrong password.');
          return;
        }
        startSession();
        // Mirror into the backend when reachable (same User row + cookie).
        try {
          await mirrorAuth('login', { username: existing.username, password });
        } catch {
          /* standalone — local session stands */
        }
        onDone(existing);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign-in failed.');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!username.trim()) {
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
    setBusy(true);
    try {
      if (serverMode && !serverBootstrap) {        // Backend owns accounts and this origin has no profile — plain login.
        const r = await apiPost<{ ok: boolean; user: ServerAuthState['user'] }>('/auth/login', {
          username,
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
            username,
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
      const created = await bootstrapUser(username, display, password);
      try {
        await mirrorAuth('bootstrap', { username, displayName: display, password });
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

  return (
    <div onKeyDown={onKey}>
      <h2 className="font-display text-base font-semibold">
        {existing
          ? `Welcome back, ${existing.displayName}`
          : isCreate
            ? 'Create primary account'
            : 'Sign in'}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">
        {existing
          ? 'Sign in to access SDCodex. Passwords are PBKDF2-hashed locally; the backend scrypt hash replaces this on migration.'
          : isCreate
            ? 'No users exist yet — this account becomes administrator. Password is required; nothing works without an account.'
            : 'This origin has no saved account — sign in with your existing credentials.'}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {!existing && (
          <>
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
          </>
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
          disabled={busy || (!existing && !username.trim())}
          onClick={() => void submit()}
        >
          {busy ? 'Working…' : existing || !isCreate ? 'Sign in' : 'Create administrator'}
        </PrimaryButton>
      </div>
    </div>
  );
}

export function Home({ go }: { go: (v: 'models' | 'library' | 'queue' | 'plugins') => void }) {  const cards = [
    { id: 'models' as const, title: 'Model Explorer', desc: 'Browse Civitai by type, base model, and tags.' },
    { id: 'library' as const, title: 'Local Library', desc: 'Downloaded weights with metadata and socket state.' },
    { id: 'queue' as const, title: 'Download Queue', desc: 'Background downloads staged from Models.' },
    { id: 'plugins' as const, title: 'Plugin Hub', desc: 'Installable Gallery, GalleryDL, RemBG, ComfyCaption.' },
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
  onClearCompleted,
  onClearAll,
}: {
  items: QueueItem[];
  onClearCompleted: () => void;
  onClearAll: () => void;
}) {
  const [paused, setPausedState] = useState(isPaused);
  const [speedLimit, setSpeedLimit] = useState('Unlimited');
  const active = items.filter((i) => i.status !== 'done');

  const togglePaused = () => {
    const next = !paused;
    setPaused(next);
    setPausedState(next);
  };

  return (
    <div>
      <PageHeader
        title="Download Manager"
        subtitle="Parallel weight streamer with hash verification and metadata scraping. Worker backend pending — staged items wait here."
        meta={`${active.length} active streams · 1.4 TB available`}
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
        <Stat label="Active sockets" value={`${active.length} of 4`} />
        <Stat label="Staged" value={String(items.length)} />
        <Stat label="State" value={paused ? 'Paused' : 'Ready'} />
      </section>

      <div className="glass-l1 mt-3 flex items-center gap-2 rounded-lg p-3 text-xs">
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
        {items.length > 0 && (
          <DangerButton className="ml-auto" onClick={onClearAll}>
            Clear all
          </DangerButton>
        )}
      </div>

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

export function Plugins() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'official'>('all');
  const shown = PLUGINS.filter((p) =>
    p.name.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <div>
      <PageHeader
        title="Plugin Hub"
        subtitle="Extensions and system orchestrator. Installer backend pending — manifests below define the install contract."
        meta={`${PLUGINS.length} official plugins · community index via SDCodex-Updater`}
      />
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
      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shown.map((p) => (
          <article key={p.id} className="glass-l1 rounded-lg p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold">{p.name}</h2>
              <span className="rounded border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase text-ink-muted">
                planned
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-muted">{p.desc}</p>
            <a
              href={p.repo}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-mono text-[11px] text-secondary hover:underline"
            >
              {p.repo}
            </a>
          </article>
        ))}
      </section>
    </div>
  );
}
