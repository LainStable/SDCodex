import { useEffect, useState } from 'react';
import { FilterPills, GhostButton, PageHeader, PrimaryButton } from '../components/chrome';
import { TypeBadge } from '../components/ui';
import { bindDirectory, scanDir } from '../lib/scan';
import { forgetHandle, getHandle } from '../lib/idb';
import { loadScanned, pruneScanned } from '../lib/library';
import {
  MODEL_TYPES,
  clearApiKey,
  deleteCustomDir,
  getApiKey,
  getApiUser,
  getCustomDirs,
  getDirectories,
  pushSettings,
  setApiKey,
  setApiUser,
  setCustomDir,
  setDirectory,
} from '../lib/settings';
import { fetchMe } from '../lib/civitai';
import {
  blankProvider,
  buildAuthUrl,
  deleteProvider,
  endSession,
  hashPassword,
  initials,
  loadProviders,
  processAvatar,
  saveProfile,
  saveProvider,
  testDiscovery,
  verifyPassword,
  type OidcProvider,
  type Profile,
} from '../lib/auth';
import { BootstrapCard } from './Core';

type Tab = 'dirs' | 'api' | 'auth' | 'system';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dirs', label: 'Model dirs' },
  { id: 'api', label: 'API key' },
  { id: 'auth', label: 'Users & SSO' },
  { id: 'system', label: 'System' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="w-40 shrink-0 font-mono text-[11px] text-ink-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
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
  const [bound, setBound] = useState<Record<string, boolean>>({});
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

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

  const save = (type: string) => {
    const key = `dir_${type}`;
    setDirectory(type, drafts[key] ?? '');
    setDirs(getDirectories());
    setSavedKey(key);
    setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500);
    void pushSettings();
  };

  const say = (line: string) => setLog((l) => [...l.slice(-8), line]);

  const resolve = async (type: string): Promise<FileSystemDirectoryHandle | null> => {
    const existing = await getHandle(`dir_${type}`);
    if (existing) return existing;
    say(`${type}: pick the folder for this path`);
    try {
      const dir = await bindDirectory(type);
      if (dir) setBound((b) => ({ ...b, [type]: true }));
      return dir;
    } catch {
      setMsgs((m) => ({ ...m, [type]: 'pick failed' }));
      return null;
    }
  };

  const forget = async (type: string) => {
    await forgetHandle(`dir_${type}`);
    setBound((b) => ({ ...b, [type]: false }));
    setMsgs((m) => ({ ...m, [type]: 'unlinked' }));
  };

  const scanOne = async (type: string) => {
    setScanning(true);
    const seen = new Set(loadScanned().map((e) => `${e.dirKey}/${e.filename}`));
    await scanDir(type, resolve, seen, (msg) =>
      setMsgs((m) => ({ ...m, [type]: msg })),
    );
    setScanning(false);
  };

  const scanAll = async () => {
    setScanning(true);
    setLog([]);
    const seen = new Set<string>();
    for (const t of MODEL_TYPES) {
      if (!(dirs[`dir_${t}`] ?? '').trim()) continue;
      await scanDir(t, resolve, seen, (msg) => {
        say(msg);
        setMsgs((m) => ({ ...m, [t]: msg }));
      });
    }
    const { removed } = pruneScanned(seen);
    say(removed > 0 ? `Removed ${removed} missing models.` : 'Scan complete.');
    setScanning(false);
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
      <p className="mt-1 font-mono text-[11px] text-ink-faint">
        Keys mirror the backend Setting table. In Docker these are container-internal
        paths served by the volumes you define (the backend scans those directly — no
        picking needed). In this browser preview, first Scan asks for the folder once,
        then remembers it.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={scanning || !supported} onClick={() => void scanAll()}>
          {scanning ? 'Scanning…' : 'Scan all folders'}
        </PrimaryButton>
        {!supported && (
          <span className="font-mono text-[11px] text-status-warning">
            Folder linking needs Chromium
          </span>
        )}
      </div>
      <div className="mt-2 divide-y divide-white/[0.06]">
        {MODEL_TYPES.map((t) => {
          const key = `dir_${t}`;
          const dirty = (drafts[key] ?? '') !== (dirs[key] ?? '');
          const isBound = bound[t] ?? false;
          return (
            <div key={t} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="w-28 shrink-0">
                <TypeBadge type={t} />
              </span>
              <input
                value={drafts[key] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                placeholder={`/models/${t.toLowerCase()}/`}
                className="min-w-[200px] flex-1 rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary"
              />
              <GhostButton disabled={!dirty} onClick={() => save(t)}>
                Save
              </GhostButton>
              {supported && (
                <>
                  <GhostButton
                    disabled={scanning || !(dirs[key] ?? '').trim()}
                    onClick={() => void scanOne(t)}
                    title={
                      isBound
                        ? 'Scan this folder'
                        : 'First scan asks for the folder once, then remembers it'
                    }
                  >
                    Scan
                  </GhostButton>
                  {isBound && (
                    <GhostButton disabled={scanning} onClick={() => void forget(t)}>
                      Unlink
                    </GhostButton>
                  )}
                </>
              )}
              {savedKey === key && (
                <span className="rounded border border-status-active/40 bg-status-active/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-active">
                  saved
                </span>
              )}
              {(msgs[t] || (isBound ? 'linked' : '')) && (
                <span className="w-full truncate font-mono text-[10px] text-ink-faint">
                  {msgs[t] || 'linked'}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {log.length > 0 && (
        <div className="mt-2 rounded border border-white/[0.06] bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-ink-muted">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

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
  const [editing, setEditing] = useState<OidcProvider | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const test = async (p: OidcProvider) => {
    setBusy(true);
    setStatus((s) => ({ ...s, [p.id]: 'checking…' }));
    try {
      const ok = await testDiscovery(p.issuerUrl);
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
      const url = await buildAuthUrl(p, `${window.location.origin}/auth/oidc/callback`);
      window.location.href = url;
    } catch (e) {
      setStatus((s) => ({ ...s, [p.id]: `FAIL · ${e instanceof Error ? e.message : 'request failed'}` }));
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-3">
      <h3 className="font-display text-sm font-semibold">Single sign-on (OIDC)</h3>
      <p className="mt-1 font-mono text-[11px] text-ink-faint">
        One row per provider — mirrors the backend OidcConfig table. Secrets stay in this
        browser until the backend vault lands.
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
                setProviders(deleteProvider(p.id));
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
                if (!editing.name.trim() || !editing.issuerUrl.trim()) return;
                setProviders(saveProvider(editing));
                setEditing(null);
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
        {tab === 'system' && <System />}
      </div>
    </div>
  );
}
