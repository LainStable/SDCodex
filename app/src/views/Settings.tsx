import { useEffect, useRef, useState } from 'react';
import { FilterPills, GhostButton, PageHeader, PrimaryButton } from '../components/chrome';
import { TypeBadge } from '../components/ui';
import { bindDirectoryKey, scanDir, serverScan, serverScanStatus } from '../lib/scan';
import { getHandle } from '../lib/idb';
import { loadScanned, pruneScanned } from '../lib/library';
import {
  MODEL_TYPES,
  addDirPath,
  clearApiKey,
  deleteCustomDir,
  getApiKey,
  getApiUser,
  getCustomDirs,
  getDirColors,
  getDirectories,
  pushSettings,
  removeDirPath,
  setApiKey,
  setApiUser,
  setCustomDir,
  setDirColor,
} from '../lib/settings';
import { fetchMe } from '../lib/civitai';
import {
  blankProvider,
  createServerProvider,
  deleteProvider,
  deleteServerProvider,
  endSession,
  fetchServerProviders,
  hashPassword,
  initials,
  loadProviders,
  processAvatar,
  pushProfile,
  saveProfile,
  saveProvider,
  serverLoginUrl,
  testDiscovery,
  testServerProvider,
  verifyPassword,
  type OidcProvider,
  type Profile,
} from '../lib/auth';
import { BootstrapCard, Plugins } from './Core';
import { clearScanLog, getScanLog, pushScanLog, subscribeScanLog } from '../lib/scanlog';

type Tab = 'dirs' | 'api' | 'auth' | 'system' | 'plugins';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dirs', label: 'Model dirs' },
  { id: 'api', label: 'API key' },
  { id: 'auth', label: 'Users & SSO' },
  { id: 'system', label: 'System' },
  { id: 'plugins', label: 'Plugins' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="w-40 shrink-0 font-mono text-[11px] text-ink-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const SWATCHES = [
  '#ffffff',
  '#fb4d6d',
  '#f97316',
  '#fbbf24',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#a855f7',
];

function isValidCssColor(v: string): boolean {
  if (!v.trim()) return false;
  const opt = new Option().style;
  opt.color = v.trim();
  return opt.color !== '';
}

/** Floating accent picker (swatches + custom dialog), as per reference.
    The category badge itself is the trigger. */
function ColorMenu({
  type,
  current,
  onPick,
  children,
}: {
  type: string;
  current: string;
  onPick: (color: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open && !customOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, customOpen]);

  const applyCustom = () => {
    if (!isValidCssColor(customValue)) {
      setCustomError('Enter a valid CSS color (hex, rgb, hsl).');
      return;
    }
    onPick(customValue.trim());
    setCustomOpen(false);
    setOpen(false);
    setCustomError(null);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setCustomOpen(false);
          setOpen((o) => !o);
        }}
        title={`Accent color for ${type}`}
        className="block"
      >
        {children}
      </button>

      {open && !customOpen && (
        <div className="glass-l2 modal-pop absolute left-0 top-8 z-50 flex gap-1.5 rounded-lg p-2">
          <button
            type="button"
            title="Default grey"
            onClick={() => {
              onPick('');
              setOpen(false);
            }}
            className={`h-6 w-6 rounded-full border-2 ${
              !current ? 'border-white' : 'border-white/25 hover:border-white/60'
            }`}
            style={{ width: 24, height: 24, backgroundColor: '#3a3f4d' }}
          />
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => {
                onPick(c);
                setOpen(false);
              }}
              className={`h-6 w-6 rounded-full border-2 ${
                current.toLowerCase() === c.toLowerCase()
                  ? 'border-white'
                  : 'border-transparent hover:border-white/50'
              }`}
              style={{ width: 24, height: 24, backgroundColor: c }}
            />
          ))}
          <button
            type="button"
            title="Custom color"
            onClick={() => {
              setCustomValue(current.startsWith('#') ? current : '');
              setCustomError(null);
              setCustomOpen(true);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-white/40 text-[10px] text-white hover:border-white"
            style={{ width: 24, height: 24 }}
          >
            +
          </button>
        </div>
      )}

      {customOpen && (
        <div className="glass-l2 modal-pop absolute left-0 top-8 z-50 w-72 rounded-lg p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-display text-sm font-semibold">Custom Accent Color</h3>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                Enter a custom color using valid CSS color formats (e.g., hex, rgb, hsl).
              </p>
            </div>
            <GhostButton onClick={() => setCustomOpen(false)}>✕</GhostButton>
          </div>
          <label className="mt-3 block">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
              Color Value
            </span>
            <input
              value={customValue}
              onChange={(e) => {
                setCustomValue(e.target.value);
                setCustomError(null);
              }}
              placeholder="#3b82f6"
              className="mt-1 w-full rounded border border-white/15 bg-obsidian-lowest px-3 py-2 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary"
            />
          </label>
          {customError && (
            <p className="mt-1 font-mono text-[10px] text-[#f87171]">{customError}</p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setCustomOpen(false)}>Cancel</GhostButton>
            <PrimaryButton onClick={applyCustom}>Apply</PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Dirs() {
  const supported =
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  const [dirs, setDirs] = useState(getDirectories);
  const [drafts, setDrafts] = useState<Record<string, string>>(getDirectories);
  const [custom, setCustom] = useState(getCustomDirs);
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [colors, setColors] = useState<Record<string, string>>(getDirColors);
  const [bound, setBound] = useState<Record<string, boolean>>({});
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const entries = await Promise.all(
        MODEL_TYPES.map(async (t) => [t, (await getHandle(`dir_${t}`)) !== null] as const),
      );
      if (live) setBound(Object.fromEntries(entries));
    })();
    return () => {
      live = false;
    };
  }, []);

  const saveType = (t: string) => {
    const dirsNow = getDirectories();
    const next = { ...dirsNow };
    for (const k of Object.keys(drafts)) {
      if (k === `dir_${t}` || k.startsWith(`dir_${t}__`)) next[k] = drafts[k] ?? '';
    }
    try {
      localStorage.setItem('sdcodex.dirs.v1', JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setDirs(getDirectories());
    setSavedKey(`dir_${t}`);
    setTimeout(() => setSavedKey((k) => (k === `dir_${t}` ? null : k)), 1500);
    void pushSettings();
  };

  const refreshDirs = () => {
    setDirs(getDirectories());
    setDrafts(getDirectories());
  };

  const say = (line: string) => pushScanLog(line);

  const resolveAll = async (type: string): Promise<FileSystemDirectoryHandle[]> => {
    // Every saved path for the category gets its own bound folder.
    const keys = [`dir_${type}`, ...Object.keys(getDirectories()).filter((k) => k.startsWith(`dir_${type}__`)).sort()];
    const out: FileSystemDirectoryHandle[] = [];
    for (const key of keys) {
      if (!(getDirectories()[key] ?? '').trim()) continue;
      const existing = await getHandle(key);
      if (existing) {
        out.push(existing);
        continue;
      }
      say(`${type}: pick the folder for this path`);
      try {
        const dir = await bindDirectoryKey(key);
        if (dir) {
          setBound((b) => ({ ...b, [type]: true }));
          out.push(dir);
        }
      } catch {
        setMsgs((m) => ({ ...m, [type]: 'pick failed' }));
      }
    }
    return out;
  };

  const scanOne = async (type: string) => {
    setScanning(true);
    try {
      // Backend first: server scans its own paths, no picker involved.
      await serverScan([type]);
      setMsgs((m) => ({ ...m, [type]: 'scan started on server…' }));
      await pollServer();
      return;
    } catch (e) {
      if (!supported) {
        setMsgs((m) => ({
          ...m,
          [type]: `server scan failed (${e instanceof Error ? e.message : 'unreachable'}) — folder linking needs Chromium`,
        }));
        setScanning(false);
        return;
      }
      /* standalone — fall through to the browser flow below */
    }
    try {
      const seen = new Set(loadScanned().map((e) => `${e.dirKey}/${e.filename}`));
      await scanDir(type, resolveAll, seen, (msg) =>
        setMsgs((m) => ({ ...m, [type]: msg })),
      );
    } finally {
      setScanning(false);
    }
  };

  /** Poll the backend worker until idle (max ~30s), surfacing its message. */
  const pollServer = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const s = await serverScanStatus();
        const msg = s.current_task?.message || (s.queue_length > 0 ? 'queued…' : '');
        if (msg) say(msg);
        if (!s.current_task && s.queue_length === 0) {
          say('Scan complete (server). Refresh Library to see results.');
          break;
        }
      } catch {
        break;
      }
    }
    setScanning(false);
  };

  const scanAll = async () => {
    setScanning(true);
    try {
      await serverScan();
      say('Scan started on server…');
      await pollServer();
      return;
    } catch (e) {
      if (!supported) {
        say(`Server scan failed (${e instanceof Error ? e.message : 'unreachable'}) — folder linking needs Chromium.`);
        setScanning(false);
        return;
      }
      /* standalone — fall through */
    }
    try {
      const seen = new Set<string>();
      for (const t of MODEL_TYPES) {
        if (!(dirs[`dir_${t}`] ?? '').trim()) continue;
        await scanDir(t, resolveAll, seen, (msg) => {
          say(msg);
          setMsgs((m) => ({ ...m, [t]: msg }));
        });
      }
      const { removed } = pruneScanned(seen);
      say(removed > 0 ? `Removed ${removed} missing models.` : 'Scan complete.');
    } finally {
      setScanning(false);
    }
  };

  const addCustom = () => {
    if (!label.trim() || !path.trim()) return;
    setCustomDir(label.trim(), path.trim());
    setCustom(getCustomDirs());
    setLabel('');
    setPath('');
    void pushSettings();
  };

  return (
    <div className="glass-l1 rounded-lg p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-base font-semibold">Model directories</h2>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={scanning} onClick={() => void scanAll()}>
          {scanning ? 'Scanning…' : 'Scan all folders'}
        </PrimaryButton>
      </div>
      <div className="mt-2 divide-y divide-white/[0.06]">
        {MODEL_TYPES.map((t) => {
          const keys = [`dir_${t}`, ...Object.keys(dirs).filter((k) => k.startsWith(`dir_${t}__`)).sort()];
          const hasSaved = keys.some((k) => (dirs[k] ?? '').trim() !== '');
          const dirty = keys.some((k) => (drafts[k] ?? '') !== (dirs[k] ?? ''));
          const pickColor = (color: string) => {
            setDirColor(t, color);
            setColors(getDirColors());
            void pushSettings();
          };
          return (
            <div key={t} className="py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <ColorMenu type={t} current={colors[t] ?? ''} onPick={pickColor}>
                  <span className="block cursor-pointer" title={`${t} — click to set accent color`}>
                    <TypeBadge type={t} color={colors[t]} />
                  </span>
                </ColorMenu>
                {hasSaved && !colors[t] && (
                  <span className="font-mono text-[10px] text-ink-faint">
                    click badge for color
                  </span>
                )}
                {(msgs[t] || (bound[t] ? 'linked' : '')) && (
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
                    {msgs[t] || 'linked'}
                  </span>
                )}
              </div>
              {keys.map((key) => {
                const extra = key !== `dir_${t}`;
                return (
                  <div key={key} className="mt-1 flex items-center gap-2 sm:pl-32">
                    <input
                      value={drafts[key] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      placeholder={extra ? 'Another folder…' : `/models/${t.toLowerCase()}/`}
                      className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary"
                    />
                    {extra && (
                      <GhostButton
                        className="shrink-0"
                        onClick={() => {
                          removeDirPath(key);
                          refreshDirs();
                          void pushSettings();
                        }}
                      >
                        Remove
                      </GhostButton>
                    )}
                  </div>
                );
              })}
              <div className="mt-1 flex items-center gap-2 sm:pl-32">
                <GhostButton
                  onClick={() => {
                    addDirPath(t, '');
                    refreshDirs();
                  }}
                >
                  + Path
                </GhostButton>
                <GhostButton disabled={!dirty} onClick={() => saveType(t)}>
                  Save
                </GhostButton>
                <GhostButton
                  disabled={scanning || !keys.some((k) => (dirs[k] ?? '').trim())}
                  onClick={() => void scanOne(t)}
                  title="Scans every saved folder for this category"
                >
                  Scan
                </GhostButton>
                {savedKey === `dir_${t}` && (
                  <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
                    saved
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <h2 className="mt-4 font-display text-base font-semibold">Custom directories</h2>
      {Object.entries(custom).map(([k, v]) => (
        <Row key={k} label={`dir_custom_${k}`}>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{v}</span>
            <GhostButton
              onClick={() => {
                deleteCustomDir(k);
                setCustom(getCustomDirs());
                void pushSettings();
              }}
            >
              Delete
            </GhostButton>
        </Row>
      ))}
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          className="w-32 rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary"
        />
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/data/my_models/"
          className="min-w-[220px] flex-1 rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary"
        />
        <GhostButton onClick={addCustom}>Add</GhostButton>
      </div>
    </div>
  );
}

function ApiKey() {
  const [key, setKey] = useState(getApiKey);
  const [user, setUser] = useState(getApiUser);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Save validates first (mirrors OldCode save_api_key → get_user): the key is
  // only stored when Civitai confirms it, and the panel shows who it belongs to.
  const save = async () => {
    if (!key.trim()) {
      setStatus({ ok: false, text: 'Paste a key first.' });
      return;
    }
    setBusy(true);
    setStatus({ ok: true, text: 'Validating…' });
    try {
      const me = await fetchMe(key);
      const username = me.username ?? '(unknown)';
      setApiKey(key);
      setApiUser(username);
      setUser(username);
      setStatus({ ok: true, text: `Logged in as @${username}` });
      void pushSettings();
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : 'Validation failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-l1 rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold">Civitai API key</h2>
        {user && (
          <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
            @{user}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Sent as a Bearer token on every Civitai request (same as OldCode headers). Stored only
        in this browser until user accounts land.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setStatus(null);
          }}
          type="password"
          placeholder="Paste key…"
          className="min-w-[220px] flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary"
        />
        <PrimaryButton disabled={busy} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
        </PrimaryButton>
        {key && (
          <GhostButton
            onClick={() => {
              clearApiKey();
              setKey('');
              setUser('');
              setStatus(null);
            }}
          >
            Clear
          </GhostButton>
        )}
      </div>
      {status && (
        <p
          className={`mt-2 font-mono text-[11px] ${
            status.ok && !status.text.startsWith('Validating')
              ? 'text-status-active'
              : status.ok
                ? 'text-ink-faint'
                : 'text-[#f87171]'
          }`}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

function OidcManager() {
  const [providers, setProviders] = useState(loadProviders);
  const [serverMode, setServerMode] = useState(false);
  const [editing, setEditing] = useState<OidcProvider | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Providers must live server-side for SSO to work (the exchange needs the
  // client secret + PKCE verifier). With a backend, rows come from /api/oidc.
  useEffect(() => {
    let live = true;
    void (async () => {
      const { backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) return;
      try {
        const rows = await fetchServerProviders();
        if (live) {
          setProviders(rows);
          setServerMode(true);
        }
      } catch {
        /* stay local */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const test = async (p: OidcProvider) => {
    setBusy(true);
    setStatus((s) => ({ ...s, [p.id]: 'checking…' }));
    try {
      const ok = serverMode ? await testServerProvider(p.id) : await testDiscovery(p.issuerUrl);
      setStatus((s) => ({ ...s, [p.id]: ok }));
    } catch (e) {
      setStatus((s) => ({ ...s, [p.id]: `FAIL · ${e instanceof Error ? e.message : 'request failed'}` }));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (p: OidcProvider) => {
    setBusy(true);
    try {
      if (!serverMode) {
        setStatus((s) => ({ ...s, [p.id]: 'Start the backend first — SSO exchange runs server-side.' }));
        setBusy(false);
        return;
      }
      window.location.href = await serverLoginUrl(p.id);
    } catch (e) {
      setStatus((s) => ({ ...s, [p.id]: `FAIL · ${e instanceof Error ? e.message : 'request failed'}` }));
      setBusy(false);
    }
  };

  const saveEditing = async () => {
    if (!editing || !editing.name.trim() || !editing.issuerUrl.trim()) return;
    if (serverMode) {
      await createServerProvider(editing);
      setProviders(await fetchServerProviders());
    } else {
      setProviders(saveProvider(editing));
    }
    setEditing(null);
  };

  const remove = async (id: string) => {
    if (serverMode) {
      await deleteServerProvider(id);
      setProviders(await fetchServerProviders());
    } else {
      setProviders(deleteProvider(id));
    }
  };

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-3">
      <h3 className="font-display text-sm font-semibold">Single sign-on (OIDC)</h3>
      <p className="mt-1 font-mono text-[11px] text-ink-faint">
        {serverMode
          ? 'Rows live in the backend OidcConfig table — Test and Sign in run against the server.'
          : 'No backend: rows stay in this browser. Start the backend to make SSO real.'}
      </p>
      {providers.map((p) => (
        <div key={p.id} className="mt-2 rounded border border-white/[0.06] p-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{p.name || '(unnamed)'}</span>
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                p.enabled
                  ? 'border-status-active/40 text-status-active'
                  : 'border-white/15 text-ink-faint'
              }`}
            >
              {p.enabled ? 'enabled' : 'disabled'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {p.issuerUrl}
            </span>
            <GhostButton disabled={busy} onClick={() => test(p)}>
              Test
            </GhostButton>
            <GhostButton disabled={busy || !p.enabled} onClick={() => signIn(p)}>
              Sign in
            </GhostButton>
            <GhostButton onClick={() => setEditing({ ...p })}>Edit</GhostButton>
            <GhostButton
              onClick={() => {
                void remove(p.id);
              }}
            >
              Delete
            </GhostButton>
          </div>
          {status[p.id] && (
            <p
              className={`mt-1 font-mono text-[11px] ${
                status[p.id].startsWith('OK') ? 'text-status-active' : 'text-status-warning'
              }`}
            >
              {status[p.id]}
            </p>
          )}
        </div>
      ))}
      <GhostButton className="mt-2" onClick={() => setEditing(blankProvider())}>
        + Add provider
      </GhostButton>

      {editing && (
        <div className="mt-2 rounded border border-primary/40 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ['name', 'Name (e.g. Keycloak)'],
                ['issuerUrl', 'Issuer URL'],
                ['clientId', 'Client ID'],
                ['clientSecret', 'Client secret'],
                ['redirectUri', 'Redirect URI (must match provider registration)'],
                ['scopes', 'Scopes'],
                ['usernameClaim', 'Username claim'],
                ['emailClaim', 'Email claim'],
                ['displayNameClaim', 'Display-name claim'],
                ['adminClaim', 'Admin claim (optional)'],
                ['adminValue', 'Admin value(s), comma-separated'],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="block">
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  {label}
                </span>
                <input
                  value={editing[field]}
                  type={field === 'clientSecret' ? 'password' : 'text'}
                  onChange={(e) => setEditing({ ...editing, [field]: e.target.value })}
                  className="mt-1 w-full rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-xs outline-none focus:border-primary"
                />
              </label>
            ))}
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              className="accent-[#6366f1]"
            />
            Enabled
          </label>
          <div className="mt-2 flex gap-2">
            <PrimaryButton
              onClick={() => {
                void (async () => {
                  if (!editing.name.trim() || !editing.issuerUrl.trim()) return;
                  await saveEditing();
                })();
              }}
            >
              Save provider
            </PrimaryButton>
            <GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Auth({
  profile,
  onProfile,
  onSignOut,
}: {
  profile: Profile | null;
  onProfile: (p: Profile | null) => void;
  onSignOut: () => void;
}) {
  const [editDisplay, setEditDisplay] = useState(profile?.displayName ?? '');
  const [editEmail, setEditEmail] = useState(profile?.email ?? '');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  if (!profile) {
    return (
      <div className="glass-l1 rounded-lg p-4">
        <BootstrapCard existing={null} serverMode={false} serverBootstrap={true} onDone={onProfile} />
      </div>
    );
  }
  const persist = (next: Profile) => {
    saveProfile(next);
    onProfile(next);
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 1500);
    void pushProfile(next);
  };

  const onAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setAvatarError('That file is not an image.');
      return;
    }
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      persist({ ...profile, avatar: await processAvatar(file) });
    } catch (e) {
      setAvatarError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setAvatarBusy(false);
    }
  };

  const changePassword = async () => {
    setPwMsg(null);
    if (!(await verifyPassword(curPw, profile.passwordHash))) {
      setPwMsg({ ok: false, text: 'Current password is wrong.' });
      return;
    }
    if (newPw.length < 8) {
      setPwMsg({ ok: false, text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPw !== newPw2) {
      setPwMsg({ ok: false, text: 'New passwords do not match.' });
      return;
    }
    setPwBusy(true);
    try {
      persist({ ...profile, passwordHash: await hashPassword(newPw) });
      setCurPw('');
      setNewPw('');
      setNewPw2('');
      setPwMsg({ ok: true, text: 'Password changed.' });
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div className="glass-l1 rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold">Profile</h2>
        {profile.isAdmin && (
          <span className="rounded border border-primary/50 bg-primary/20 px-2 py-0.5 font-mono text-[10px] uppercase text-white">
            admin
          </span>
        )}
        <span className="font-mono text-[11px] text-ink-faint">via {profile.authProvider}</span>
        {savedTick && (
          <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
            saved
          </span>
        )}
        <GhostButton
          className="ml-auto"
          onClick={() => {
            endSession();
            onSignOut();
          }}
        >
          Sign out
        </GhostButton>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="block h-16 w-16 overflow-hidden rounded-lg bg-gradient-to-br from-primary via-secondary to-tertiary p-[2px]">
          {profile.avatar ? (
            <img src={profile.avatar} alt="" className="h-full w-full rounded-md object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center rounded-md bg-obsidian-low font-display text-lg font-bold text-white">
              {initials(profile)}
            </span>
          )}
        </span>
        <div className="flex flex-col gap-1.5">
          <label className="cursor-pointer">
            <span className="rounded border border-white/15 px-3 py-1.5 text-xs text-ink-muted hover:bg-white/5 hover:text-white">
              {avatarBusy ? 'Processing…' : profile.avatar ? 'Change picture' : 'Upload picture'}
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={avatarBusy}
              onChange={(e) => {
                void onAvatarFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {profile.avatar && (
            <button
              type="button"
              onClick={() => persist({ ...profile, avatar: '' })}
              className="font-mono text-[10px] text-ink-faint hover:text-white"
            >
              Remove
            </button>
          )}
          {avatarError && (
            <span className="font-mono text-[10px] text-[#f87171]">{avatarError}</span>
          )}
        </div>
      </div>

      <div className="mt-3 grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Username (locked)
          </span>
          <input value={profile.username} disabled className="mt-1 w-full rounded border border-white/[0.06] bg-white/[0.02] px-3 py-2 font-mono text-sm text-ink-faint outline-none" />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Display name
          </span>
          <div className="mt-1 flex gap-2">
            <input
              value={editDisplay}
              onChange={(e) => setEditDisplay(e.target.value)}
              className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <GhostButton
              onClick={() => {
                persist({ ...profile, displayName: editDisplay.trim() || profile.username });
              }}
            >
              Save
            </GhostButton>
          </div>
        </label>
        <label className="block sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Email
          </span>
          <div className="mt-1 flex gap-2">
            <input
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              type="email"
              placeholder="you@example.com"
              className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
            />
            <GhostButton
              onClick={() => {
                persist({ ...profile, email: editEmail.trim() });
              }}
            >
              Save
            </GhostButton>
          </div>
        </label>
      </div>

      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <h3 className="font-display text-sm font-semibold">Change password</h3>
        <div className="mt-2 grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            value={curPw}
            onChange={(e) => setCurPw(e.target.value)}
            type="password"
            autoComplete="current-password"
            placeholder="Current"
            className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
          />
          <input
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder="New (min 8)"
            className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
          />
          <input
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new"
            className="rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <GhostButton disabled={pwBusy} onClick={() => void changePassword()}>
            {pwBusy ? 'Working…' : 'Change password'}
          </GhostButton>
          {pwMsg && (
            <span className={`font-mono text-[11px] ${pwMsg.ok ? 'text-status-active' : 'text-[#f87171]'}`}>
              {pwMsg.text}
            </span>
          )}
        </div>
      </div>

      {profile.isAdmin ? (
        <OidcManager />
      ) : (
        <p className="mt-4 border-t border-white/[0.06] pt-3 font-mono text-[11px] text-ink-faint">
          SSO provider settings are visible to administrators only.
        </p>
      )}
    </div>
  );
}

function System() {
  return (
    <div className="glass-l1 rounded-lg p-4">
      <h2 className="font-display text-base font-semibold">System</h2>
      <dl className="mt-3 space-y-1 font-mono text-[11px] text-ink-muted">
        <div className="flex justify-between gap-2">
          <dt>app</dt>
          <dd className="text-ink">SDCodex v2.4.0 (frontend slice)</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>health</dt>
          <dd>
            backend pending · <span className="font-mono">/healthz</span> unwired
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>self-update</dt>
          <dd>Docker sidecar (OldCode docker_api) — backend only</dd>
        </div>
      </dl>
      <p className="mt-3 font-mono text-[11px] text-ink-faint">
        Check-for-updates and container replace arrive with the backend. Core update checks
        will reuse the Plugin Hub surface.
      </p>
    </div>
  );
}

function ScanLogs() {
  const [log, setLog] = useState<string[]>(getScanLog);

  useEffect(() => subscribeScanLog(setLog), []);

  return (
    <div className="glass-l1 mt-3 rounded-lg p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-base font-semibold">Scan logs</h2>
        {log.length > 0 && <GhostButton onClick={() => clearScanLog()}>Clear</GhostButton>}
      </div>
      {log.length === 0 ? (
        <p className="mt-2 font-mono text-[11px] text-ink-faint">
          No scans yet — run one from Model dirs.
        </p>
      ) : (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-white/[0.06] bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-ink-muted">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Settings({
  profile,
  onProfile,
  onSignOut,
}: {
  profile: Profile | null;
  onProfile: (p: Profile | null) => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>('dirs');
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Download locations, credentials, access, and system — same tabs as the backend."
      />
      <div className="glass-l1 edge-shimmer mt-4 rounded-lg p-3">
        <FilterPills options={TABS} active={tab} onPick={setTab} />
      </div>
      <div className="mt-3">
        {tab === 'dirs' && <Dirs />}
        {tab === 'api' && <ApiKey />}
        {tab === 'auth' && <Auth profile={profile} onProfile={onProfile} onSignOut={onSignOut} />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'system' && (
          <>
            <System />
            <ScanLogs />
          </>
        )}
      </div>
    </div>
  );
}
