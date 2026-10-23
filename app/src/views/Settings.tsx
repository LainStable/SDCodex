import { useEffect, useRef, useState } from 'react';
import { FilterPills, GhostButton, PageHeader, PrimaryButton } from '../components/chrome';
import { AssistantPanel, McpPanel } from '../components/assistantPanels';
import { TypeBadge } from '../components/ui';
import { bindDirectoryKey, identifyUnknownModels, scanDir, serverScan, serverScanStatus, type ScanRoot } from '../lib/scan';
import { getHandle } from '../lib/idb';
import { loadScanned, pruneScanned } from '../lib/library';
import {
  API_MIRRORS,
  MODEL_TYPES,
  addDirPath,
  clearApiKey,
  deleteCustomDir,
  getApiKey,
  getApiMirror,
  getApiUser,
  getCustomDirs,
  getDirColors,
  getDirectories,
  getStabilityMatrix,
  setStabilityMatrix,
  getOrganizeByBase,
  pushSettings,
  removeDirPath,
  setApiKey,
  setApiMirror,
  setApiUser,
  setCustomDir,
  setDirColor,
  setOrganizeByBase,
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
import AvatarCrop from '../components/AvatarCrop';
import { clearScanLog, getScanLog, pushScanLog, subscribeScanLog } from '../lib/scanlog';
import { beginScan, finishScan, updateScan } from '../lib/scanstate';
import {
  allThemes,
  customThemeSlug,
  deleteCustomTheme,
  findTheme,
  isCustomTheme,
  loadTheme,
  saveCustomTheme,
  saveTheme,
  DEFAULT_THEME_SLUG,
  THEME_VAR_KEYS,
  THEME_VAR_LABELS,
  type ThemeDef,
} from '../lib/themes';
import {
  LOGIN_BG_EVENT,
  DEFAULT_LOGIN_BG_OPACITY,
  clearLoginBackground,
  loadLoginBackground,
  loginBackgroundBytes,
  loginBackgroundOpacity,
  prepareLoginBackground,
  saveLoginBackground,
  type LoginBackground,
} from '../lib/loginBackground';


function Row({ label, children }: { label: string; children: React.ReactNode }) {  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="w-40 shrink-0 font-mono text-[11px] text-ink-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function isValidCssColor(v: string): boolean {
  if (!v.trim()) return false;
  const opt = new Option().style;
  opt.color = v.trim();
  return opt.color !== '';
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    case 5: [r, g, b] = [v, p, q]; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

/** Floating accent picker: HSV color wheel with hex input below. */
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
  const [hexValue, setHexValue] = useState(current.startsWith('#') ? current : '');
  const wheelRef = useRef<HTMLCanvasElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Draw color wheel on canvas when open
  useEffect(() => {
    if (!open || !wheelRef.current) return;
    const canvas = wheelRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 4;

    ctx.clearRect(0, 0, size, size);
    for (let angle = 0; angle < 360; angle++) {
      const start = (angle * Math.PI) / 180;
      const end = ((angle + 1) * Math.PI) / 180;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, `hsl(${angle}, 0%, 100%)`);
      gradient.addColorStop(0.5, `hsl(${angle}, 100%, 50%)`);
      gradient.addColorStop(1, `hsl(${angle}, 100%, 30%)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, end);
      ctx.closePath();
      ctx.fill();
    }
  }, [open]);

  const onWheelClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = wheelRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const radius = canvas.width / 2 - 4;

    if (distance > radius) return;

    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const saturation = Math.max(0, 100 - (distance / radius) * 100);
    const value = Math.min(100, Math.max(30, saturation));
    const { r, g, b } = hsvToRgb(hue, saturation / 100, value / 100);
    const hex = rgbToHex(r, g, b);

    setHexValue(hex);
    onPick(hex);
    setOpen(false);
  };

  const onHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHexValue(val);
    if (isValidCssColor(val)) onPick(val);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Accent color for ${type}`}
        className="block"
      >
        {children}
      </button>

      {open && (
        <div className="glass-l2 modal-pop absolute left-0 top-8 z-50 flex flex-col items-center rounded-lg p-3">
          <canvas
            ref={wheelRef}
            width={180}
            height={180}
            className="rounded-full cursor-pointer"
            onClick={onWheelClick}
          />
          <div className="mt-2 flex items-center gap-2 w-full justify-center">
            <input
              value={hexValue}
              onChange={onHexChange}
              placeholder="#3b82f6"
              className="w-28 rounded border border-white/10 bg-obsidian-lowest px-2 py-1 font-mono text-[10px] text-ink-faint outline-none focus:border-primary"
            />
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
  const [organize, setOrganize] = useState(getOrganizeByBase);
  const [stability, setStability] = useState(getStabilityMatrix);
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

  // Merge saved rows into drafts without clobbering unsaved edits.
  // Never deletes: unsaved rows live in drafts only until Save persists them.
  const refreshDirs = () => {
    const saved = getDirectories();
    setDirs(saved);
    setDrafts((d) => {
      const next = { ...d };
      for (const k of Object.keys(saved)) {
        if (!(k in next)) next[k] = saved[k] ?? '';
      }
      return next;
    });
  };

  const saveType = (t: string) => {
    const dirsNow = getDirectories();
    const next = { ...dirsNow };
    for (const k of Object.keys(drafts)) {
      if (k === `dir_${t}` || k.startsWith(`dir_${t}__`)) {
        const v = drafts[k] ?? '';
        // Prune empty extra slots instead of storing blanks.
        if (!v.trim() && k !== `dir_${t}`) delete next[k];
        else next[k] = v;
      }
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

  const say = (line: string) => pushScanLog(line);

  const resolveAll = async (type: string): Promise<ScanRoot[]> => {
    // Every saved path for the category gets its own bound folder; the key
    // travels with the handle so records point at the folder they came from.
    const keys = [`dir_${type}`, ...Object.keys(getDirectories()).filter((k) => k.startsWith(`dir_${type}__`)).sort()];
    const out: ScanRoot[] = [];
    for (const key of keys) {
      if (!(getDirectories()[key] ?? '').trim()) continue;
      const existing = await getHandle(key);
      if (existing) {
        out.push({ key, dir: existing });
        continue;
      }
      say(`${type}: pick the folder for this path`);
      try {
        const dir = await bindDirectoryKey(key);
        if (dir) {
          setBound((b) => ({ ...b, [type]: true }));
          out.push({ key, dir });
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
      beginScan(type);
      try {
        await scanDir(
          type,
          resolveAll,
          seen,
          (msg) => setMsgs((m) => ({ ...m, [type]: msg })),
          (done, total, message) => updateScan({ label: type, current: done, total, message }),
        );
        finishScan(`${type}: scan complete.`);
      } catch (err) {
        finishScan(`${type}: scan failed — ${err instanceof Error ? err.message : 'unknown error'}`);
      }
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
      beginScan('all folders');
      try {
        for (const t of MODEL_TYPES) {
          const configured = Object.keys(dirs).some(
            (k) => (k === `dir_${t}` || k.startsWith(`dir_${t}__`)) && (dirs[k] ?? '').trim(),
          );
          if (!configured) continue;
          await scanDir(
            t,
            resolveAll,
            seen,
            (msg) => {
              say(msg);
              setMsgs((m) => ({ ...m, [t]: msg }));
            },
            (done, total, message) => updateScan({ label: t, current: done, total, message }),
          );
        }
        const { removed } = pruneScanned(seen);
        say(removed > 0 ? `Removed ${removed} missing models.` : 'Scan complete.');
        finishScan(removed > 0 ? `Scan complete. Removed ${removed} missing models.` : 'Scan complete.');
      } catch (err) {
        finishScan(`Scan failed — ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    } finally {
      setScanning(false);
    }
  };

  /** Hash + Civitai-match every model a scan saved as unidentified. */
  const identifyAll = async () => {
    setScanning(true);
    try {
      await serverScan(undefined, 'identify');
      say('Identify started on server…');
      await pollServer();
      return;
    } catch (e) {
      if (!supported) {
        say(
          `Server identify failed (${e instanceof Error ? e.message : 'unreachable'}) — folder linking needs Chromium.`,
        );
        setScanning(false);
        return;
      }
      /* standalone — fall through to the browser flow */
    }
    try {
      beginScan('unmatched models', 'identify');
      try {
        const count = await identifyUnknownModels(
          (msg) => say(msg),
          (done, total, message) =>
            updateScan({ label: 'unmatched models', current: done, total, message }),
        );
        finishScan(`Identified ${count} unmatched model${count === 1 ? '' : 's'}.`);
      } catch (err) {
        finishScan(
          `Identification stopped — ${err instanceof Error ? err.message : 'cancelled'}`,
        );
      }
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
        <GhostButton
          disabled={scanning}
          onClick={() => void identifyAll()}
          title="Hash every unidentified model and look it up on Civitai"
        >
          Identify models
        </GhostButton>
        <label
          className="flex cursor-pointer items-center gap-2 rounded border border-white/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted hover:border-white/25"
          title="Download into <type>/<BaseModel>/ subfolders, e.g. checkpoints/Anima/"
        >
          <input
            type="checkbox"
            checked={organize}
            onChange={(e) => {
              setOrganize(e.target.checked);
              setOrganizeByBase(e.target.checked);
              void pushSettings();
            }}
            className="accent-[#6366f1]"
          />
          Organize by base
        </label>
        <label
          className="flex cursor-pointer items-center gap-2 rounded border border-white/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted hover:border-white/25"
          title="When downloading, also writes a StabilityMatrix cm-info.json sidecar."
        >
          <input
            type="checkbox"
            checked={stability}
            onChange={(e) => {
              setStability(e.target.checked);
              setStabilityMatrix(e.target.checked);
              void pushSettings();
            }}
            className="accent-[#6366f1]"
          />
          StabilityMatrix
        </label>
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
                          setDrafts((d) => {
                            const next = { ...d };
                            delete next[key];
                            return next;
                          });
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

function ApiKey({ installed }: { installed?: Array<{ id: string }> }) {
  const [key, setKey] = useState(getApiKey);
  const [user, setUser] = useState(getApiUser);
  const [mirror, setMirror] = useState(getApiMirror);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [githubSaved, setGithubSaved] = useState<boolean | null>(null);
  const [githubToken, setGithubToken] = useState('');
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [hfConfigured, setHfConfigured] = useState<boolean | null>(null);
  const [hfToken, setHfToken] = useState('');
  const [hfMessage, setHfMessage] = useState<string | null>(null);
  const comfyCaptionInstalled = installed?.some((plugin) => plugin.id === 'comfy-caption') ?? false;

  useEffect(() => {
    const refreshApiIdentity = () => {
      setKey(getApiKey());
      setUser(getApiUser());
    };
    window.addEventListener('sdcodex:api-key-changed', refreshApiIdentity);
    window.addEventListener('sdcodex:api-user-changed', refreshApiIdentity);
    return () => {
      window.removeEventListener('sdcodex:api-key-changed', refreshApiIdentity);
      window.removeEventListener('sdcodex:api-user-changed', refreshApiIdentity);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { apiGet, backendAvailable } = await import('../lib/backend');
        if (!(await backendAvailable())) return;
        const result = await apiGet<{ saved?: boolean }>('/plugins/github-token');
        setGithubSaved(Boolean(result.saved));
      } catch { /* standalone preview */ }
    })();
    if (comfyCaptionInstalled) void (async () => {
      try {
        const response = await fetch('/comfy-caption/models/token-status', { cache: 'no-store' });
        if (response.ok) setHfConfigured(Boolean((await response.json()).configured));
      } catch { /* ComfyCaption may not be installed */ }
    })();
  }, [comfyCaptionInstalled]);

  const saveHfToken = async (token: string) => {
    setHfMessage('Saving…');
    try {
      const response = await fetch('/comfy-caption/models/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setHfConfigured(Boolean(result.configured));
      setHfToken('');
      setHfMessage(result.configured ? 'Saved. Token is stored securely on the server.' : 'Token cleared.');
    } catch (e) {
      setHfMessage(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const saveGithubToken = async () => {
    setGithubMessage('Saving…');
    try {
      const { apiPost, backendAvailable } = await import('../lib/backend');
      if (!(await backendAvailable())) throw new Error('Backend unreachable.');
      const result = await apiPost<{ saved?: boolean }>('/plugins/github-token', { token: githubToken });
      setGithubSaved(Boolean(result.saved));
      setGithubToken('');
      setGithubMessage(result.saved ? 'Saved.' : 'Cleared.');
    } catch (e) {
      setGithubMessage(e instanceof Error ? e.message : 'Save failed');
    }
  };

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
        Sent as a Bearer token on Civitai requests and saved to your account after validation.
        Save validates against the selected host.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
          API host:
        </span>
        <FilterPills
          options={API_MIRRORS.map((h) => ({ id: h, label: h }))}
          active={mirror}
          onPick={(h) => {
            setMirror(h);
            setApiMirror(h);
            setUser('');
            setStatus(null);
            void pushSettings();
          }}
        />
      </div>
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
              void pushSettings();
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
      {comfyCaptionInstalled && (
        <div className="mt-4 border-t border-white/[0.06] pt-3">
          <h3 className="font-display text-sm font-semibold">HuggingFace token</h3>
          <p className="mt-1 text-xs text-ink-muted">Used by ComfyCaption to download gated caption models. The saved token is never shown.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-ink-faint">{hfConfigured == null ? 'Checking…' : hfConfigured ? 'Saved' : 'Not set'}</span>
            <input value={hfToken} onChange={(e) => setHfToken(e.target.value)} placeholder="HuggingFace token" type="password" autoComplete="off" className="min-w-[220px] flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary" />
            <GhostButton onClick={() => void saveHfToken(hfToken)}>Save key</GhostButton>
            {hfConfigured && <GhostButton onClick={() => void saveHfToken('')}>Clear</GhostButton>}
            {hfMessage && <span className="font-mono text-[10px] text-ink-faint">{hfMessage}</span>}
          </div>
        </div>
      )}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <h3 className="font-display text-sm font-semibold">GitHub key</h3>
        <p className="mt-1 text-xs text-ink-muted">Used to access private plugin repositories. The saved key is never shown.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] text-ink-faint">{githubSaved == null ? '' : githubSaved ? 'Saved' : 'Not set'}</span>
          <input value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="GitHub token" type="password" autoComplete="off" className="min-w-[220px] flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 font-mono text-xs outline-none placeholder:text-ink-faint focus:border-primary" />
          <GhostButton onClick={() => void saveGithubToken()}>Save key</GhostButton>
          {githubMessage && <span className="font-mono text-[10px] text-ink-faint">{githubMessage}</span>}
        </div>
      </div>
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
              className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase ${
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
  const [cropSrc, setCropSrc] = useState<string | null>(null);
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
    // Surface sync failure instead of swallowing it: an unpushed avatar
    // followed by a pull is how profile pictures get "lost".
    void pushProfile(next).then((ok) => {
      if (!ok) setAvatarError('Saved locally — server sync failed, will retry automatically.');
    });
  };

  const onAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setAvatarError('That file is not an image.');
      return;
    }
    setAvatarError(null);
    setCropSrc(URL.createObjectURL(file));
  };

  const closeCrop = () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    setAvatarBusy(false);
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
      {cropSrc && (
        <AvatarCrop
          src={cropSrc}
          onCancel={closeCrop}
          onDone={(dataUrl) => {
            persist({ ...profile, avatar: dataUrl });
            closeCrop();
          }}
        />
      )}

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
    </div>
  );
}

/* ---------------------------------------------------------------- themes --- */

/** `R G B` token → `#rrggbb` for <input type="color">. */
function rgbTripletToHex(value?: string): string {
  const parts = (value ?? '').trim().split(/\s+/).map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '#000000';
  return `#${parts
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function hexToRgbTriplet(hex: string): string {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return '0 0 0';
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function LoginBackgroundField() {
  const [background, setBackground] = useState<LoginBackground | null>(() => loadLoginBackground());
  const [opacity, setOpacity] = useState<number>(() => {
    const current = loadLoginBackground();
    return current ? Math.round(loginBackgroundOpacity(current) * 100) : 100;
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sync = () => {
      const current = loadLoginBackground();
      setBackground(current);
      setOpacity(current ? Math.round(loginBackgroundOpacity(current) * 100) : 100);
    };
    window.addEventListener(LOGIN_BG_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(LOGIN_BG_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const persistOpacity = (value: number) => {
    if (!background) return;
    const next: LoginBackground = {
      ...background,
      opacity: Math.min(1, Math.max(0, value / 100)),
    };
    try {
      saveLoginBackground(next);
      setBackground(next);
      setMessage(null);
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : 'Could not save the opacity.',
      });
    }
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const prepared = await prepareLoginBackground(file);
      // Replacing the image keeps the chosen opacity.
      const keep = background ? loginBackgroundOpacity(background) : DEFAULT_LOGIN_BG_OPACITY;
      const next = { ...prepared, opacity: keep };
      saveLoginBackground(next);
      setBackground(next);
      setOpacity(Math.round(keep * 100));
      setMessage({ ok: true, text: `Login background set from ${file.name}.` });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : 'Could not use that image.',
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = () => {
    clearLoginBackground();
    setBackground(null);
    setMessage({ ok: true, text: 'Login background removed.' });
  };

  const sizeLabel = background
    ? `${background.width}×${background.height} · ${Math.round(loginBackgroundBytes(background) / 1024)} KB`
    : '';

  return (
    <div className="mt-4 rounded border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">Login background</h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            Image shown behind the sign-in card. Uploads are scaled to fit 1920×1080 and stored in
            this browser, so they also apply on a fresh login.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          <GhostButton disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Processing…' : background ? 'Replace image' : 'Upload image'}
          </GhostButton>
          {background && (
            <GhostButton
              className="border-status-alert/40 text-[#f87171]"
              onClick={remove}
              title="Remove the login background"
            >
              Remove
            </GhostButton>
          )}
        </div>
      </div>

      {background ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <img
            src={background.dataUrl}
            alt="Login background preview"
            className="h-20 w-32 shrink-0 rounded border border-white/10 object-cover"
          />
          <div className="min-w-0 font-mono text-[10px] text-ink-faint">
            <p className="truncate text-ink-muted">{background.name}</p>
            <p className="mt-0.5">{sizeLabel}</p>
          </div>
        </div>
      ) : (
        <p className="mt-3 font-mono text-[10px] text-ink-faint">
          No background set — the login gate uses the theme background.
        </p>
      )}

      {background && (
        <div className="mt-3 flex items-center gap-3">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Opacity
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
            onPointerUp={() => persistOpacity(opacity)}
            onKeyUp={() => persistOpacity(opacity)}
            onBlur={() => persistOpacity(opacity)}
            aria-label="Login background image opacity"
            title="Background image opacity on the login page"
            className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-[#6366f1]"
          />
          <span className="w-9 shrink-0 text-right font-mono text-[10px] text-ink-muted">{opacity}%</span>
        </div>
      )}

      {message && (
        <p
          className={`mt-2 font-mono text-[11px] ${message.ok ? 'text-status-active' : 'text-[#f87171]'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function Themes() {
  const [library, setLibrary] = useState<ThemeDef[]>(() => allThemes());
  const [slug, setSlug] = useState<string>(() => loadTheme());
  const active = findTheme(slug) ?? library[0];
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...active.vars }));
  const [name, setName] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Selecting a theme loads its palette into the editor. Custom themes keep
  // their own name; built-ins seed a "<name> copy" suggestion.
  useEffect(() => {
    const theme = findTheme(slug);
    if (!theme) return;
    setDraft({ ...theme.vars });
    setName(isCustomTheme(slug) ? theme.name : `${theme.name} copy`);
    setMessage(null);
  }, [slug]);

  const pushProfileTheme = (next: string) => {
    void (async () => {
      try {
        const { apiPut, backendAvailable } = await import('../lib/backend');
        if (await backendAvailable()) await apiPut('/profile', { theme: next });
      } catch {
        /* local choice still applies */
      }
    })();
  };

  const apply = (next: string) => {
    saveTheme(next);
    setSlug(next);
    setLibrary(allThemes());
    pushProfileTheme(next);
  };

  const saveAsNew = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setMessage({ ok: false, text: 'Give the theme a name first.' });
      return;
    }
    const nextSlug = customThemeSlug(trimmed);
    if (nextSlug !== slug && library.some((t) => t.slug === nextSlug)) {
      setMessage({ ok: false, text: 'A saved theme already uses that name.' });
      return;
    }
    const theme: ThemeDef = {
      name: trimmed,
      slug: nextSlug,
      mode: active.mode,
      blurb: 'Saved from the Themes tab.',
      vars: { ...draft },
      fontDisplay: active.fontDisplay,
      fontBody: active.fontBody,
    };
    saveCustomTheme(theme);
    saveTheme(nextSlug);
    setLibrary(allThemes());
    setSlug(nextSlug);
    setMessage({ ok: true, text: `Saved “${trimmed}”.` });
    pushProfileTheme(nextSlug);
  };

  const remove = () => {
    deleteCustomTheme(slug);
    saveTheme(DEFAULT_THEME_SLUG);
    setLibrary(allThemes());
    setSlug(DEFAULT_THEME_SLUG);
    setMessage({ ok: true, text: 'Theme deleted.' });
    pushProfileTheme(DEFAULT_THEME_SLUG);
  };

  return (
    <div className="glass-l1 rounded-lg p-4">
      <h2 className="font-display text-base font-semibold">Themes</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Pick a named theme, then edit any of its colours and save the result under a name of your
        own. Saved themes appear in the picker here, on the first-run gate, and are stored on this
        account.
      </p>

      <div className="mt-3 flex max-w-xl flex-wrap items-center gap-2">
        <select
          value={slug}
          onChange={(e) => apply(e.target.value)}
          aria-label="Theme"
          className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none focus:border-primary"
        >
          {library.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.name} · {t.mode === 'dark' ? 'Dark' : 'Light'}
              {isCustomTheme(t.slug) ? ' · saved' : ''}
            </option>
          ))}
        </select>
        <span className="rounded border border-primary/50 bg-primary/20 px-2 py-0.5 font-mono text-[10px] uppercase text-white">
          {active.mode}
        </span>
      </div>
      <p className="mt-1 font-mono text-[10px] text-ink-faint">{active.blurb}</p>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {THEME_VAR_KEYS.map((key) => (
          <label
            key={key}
            className="flex items-center gap-2 rounded border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
            title={`${THEME_VAR_LABELS[key] ?? key} · ${key}`}
          >
            <input
              type="color"
              value={rgbTripletToHex(draft[key])}
              onChange={(e) => {
                const value = hexToRgbTriplet(e.target.value);
                setDraft((current) => ({ ...current, [key]: value }));
              }}
              aria-label={THEME_VAR_LABELS[key] ?? key}
              className="h-7 w-9 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent p-0"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-ink">
              {THEME_VAR_LABELS[key] ?? key}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-ink-faint">{draft[key] ?? '—'}</span>
          </label>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setMessage(null);
          }}
          placeholder="Theme name"
          aria-label="Theme name"
          className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary sm:max-w-xs"
        />
        <PrimaryButton onClick={saveAsNew}>Save theme</PrimaryButton>
        <GhostButton
          onClick={() => {
            setDraft({ ...active.vars });
            setMessage({ ok: true, text: 'Colours reset to the selected theme.' });
          }}
        >
          Revert colours
        </GhostButton>
        {isCustomTheme(slug) && (
          <GhostButton className="border-status-alert/40 text-[#f87171]" onClick={remove}>
            Delete
          </GhostButton>
        )}
      </div>

      <p className="mt-2 font-mono text-[10px] text-ink-faint">
        Colours are stored as RGB triplets (e.g. <span className="text-ink-muted">99 102 241</span>
        ), matching the CSS tokens themes use.
      </p>
      {message && (
        <p
          className={`mt-2 font-mono text-[11px] ${message.ok ? 'text-status-active' : 'text-[#f87171]'}`}
        >
          {message.text}
        </p>
      )}

      <LoginBackgroundField />
    </div>
  );
}

function System({ isAdmin }: { isAdmin: boolean }) {
  type InstallModeStatus = {
    mode: 'docker' | 'local';
    runtime_mode: 'docker' | 'local';
    matches_runtime: boolean;
  };
  const [installMode, setInstallMode] = useState<InstallModeStatus | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeMessage, setModeMessage] = useState('');

  useEffect(() => {
    let active = true;
    void import('../lib/backend')
      .then(({ apiGet }) => apiGet<InstallModeStatus>('/system/install-mode'))
      .then((status) => {
        if (active) setInstallMode(status);
      })
      .catch((error: unknown) => {
        if (active) {
          setModeMessage(error instanceof Error ? error.message : 'Unable to load install mode.');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const saveInstallMode = async (mode: 'docker' | 'local') => {
    setModeBusy(true);
    setModeMessage('');
    try {
      const { apiPut } = await import('../lib/backend');
      setInstallMode(await apiPut<InstallModeStatus>('/system/install-mode', { mode }));
      setModeMessage('Install mode saved.');
      window.dispatchEvent(new Event('sdcodex:install-mode-changed'));
    } catch (error) {
      setModeMessage(error instanceof Error ? error.message : 'Unable to save install mode.');
    } finally {
      setModeBusy(false);
    }
  };

  return (
    <div className="glass-l1 rounded-lg p-4">
      <h2 className="font-display text-base font-semibold">System</h2>
      <div className="mt-3 rounded-lg border border-white/[0.06] bg-obsidian-lowest/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm font-semibold">Installation mode</h3>
            <p className="mt-1 font-mono text-[11px] text-ink-faint">
              Select how this instance is deployed. This describes the current launch mode; it does not
              migrate or restart the app.
            </p>
          </div>
          {installMode && (
            <span className="font-mono text-[10px] uppercase text-ink-muted">
              Running: {installMode.runtime_mode}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['docker', 'local'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={!isAdmin || modeBusy || !installMode}
              aria-pressed={installMode?.mode === mode}
              onClick={() => void saveInstallMode(mode)}
              className={`rounded border px-3 py-1.5 font-mono text-[11px] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                installMode?.mode === mode
                  ? 'border-primary/60 bg-primary/15 text-white'
                  : 'border-white/10 bg-white/[0.03] text-ink-muted hover:border-white/20 hover:text-ink'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        {installMode && !installMode.matches_runtime && (
          <p role="alert" className="mt-2 font-mono text-[11px] text-[#fcd34d]">
            The selected mode does not match the running app. Restart it externally in {installMode.mode}
            {' '}mode before using the self-update/restart flow.
          </p>
        )}
        {modeMessage && (
          <p className="mt-2 font-mono text-[11px] text-ink-muted" role="status">
            {modeMessage}
          </p>
        )}
        {!isAdmin && (
          <p className="mt-2 font-mono text-[11px] text-ink-faint">
            Only administrators can change installation mode.
          </p>
        )}
      </div>
      <p className="mt-3 font-mono text-[11px] text-ink-faint">
        Updates are available from Plugin Hub. Local mode restarts the backend process; Docker mode
        uses the existing container update flow.
      </p>
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <h3 className="font-display text-sm font-semibold">Single sign-on</h3>
        {isAdmin ? (
          <div className="mt-2">
            <OidcManager />
          </div>
        ) : (
          <p className="mt-2 font-mono text-[11px] text-ink-faint">
            SSO provider settings are visible to administrators only.
          </p>
        )}
      </div>
      <AssistantPanel isAdmin={isAdmin} />
      <McpPanel isAdmin={isAdmin} />
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
  initialTab,
  installed,
}: {
  profile: Profile | null;
  onProfile: (p: Profile | null) => void;
  onSignOut: () => void;
  initialTab?: string;
  installed?: Array<{
    id: string;
    name: string;
    settings: Array<{ label: string; page: string }>;
  }>;
}) {
  // Core tabs first, then one tab per plugin settings entry. Plugins & updates
  // sits directly left of System so the update controls stay at the end.
  const tabs: { id: string; label: string }[] = [
    { id: 'dirs', label: 'Model dirs' },
    ...(installed ?? []).flatMap((p) =>
      (p.settings ?? []).map((s, i) => ({ id: `plugin:${p.id}:${i}`, label: s.label })),
    ),
    { id: 'api', label: 'API keys' },
    { id: 'auth', label: 'Profile' },
    { id: 'themes', label: 'Themes' },
    { id: 'plugins', label: 'Plugins & updates' },
    { id: 'system', label: 'System' },
  ];
  const [tab, setTab] = useState<string>(
    tabs.some((t) => t.id === initialTab) ? (initialTab as string) : 'dirs',
  );
  // Badge clicks («onGoPlugins») navigate here from any screen via
  // goSettings('plugins') — which remounts through the key AND changes
  // initialTab. Sync on prop change too, so the Plugins tab opens even if
  // the remount key ever collides (e.g. rapid double-click).
  useEffect(() => {
    if (initialTab && tabs.some((t) => t.id === initialTab) && initialTab !== tab) {
      setTab(initialTab as string);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);
  const pluginTab = tab.startsWith('plugin:')
    ? (() => {
        const [, pid, idx] = tab.split(':');
        const plugin = (installed ?? []).find((p) => p.id === pid);
        const entry = plugin?.settings[Number(idx)];
        return plugin && entry ? { plugin, entry } : null;
      })()
    : null;
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Download locations, credentials, access, and system — same tabs as the backend."
      />
      <div className="glass-l1 edge-shimmer mt-4 rounded-lg p-3">
        <FilterPills options={tabs} active={tab} onPick={setTab} />
      </div>
      <div className="mt-3">
        {tab === 'dirs' && <Dirs />}
        {tab === 'api' && <ApiKey installed={installed} />}
        {tab === 'auth' && <Auth profile={profile} onProfile={onProfile} onSignOut={onSignOut} />}
        {tab === 'themes' && <Themes />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'system' && (
          <>
            <System isAdmin={profile?.isAdmin ?? false} />
            <ScanLogs />
          </>
        )}
        {pluginTab && (
          <iframe
            key={tab}
            title={`${pluginTab.plugin.name} — ${pluginTab.entry.label}`}
            src={`/api/plugins/${pluginTab.plugin.id}/settings/${pluginTab.entry.page}`}
            className="h-[calc(100vh-240px)] min-h-[420px] w-full rounded-lg border border-white/[0.06] bg-obsidian-lowest"
          />
        )}
      </div>
    </div>
  );
}
