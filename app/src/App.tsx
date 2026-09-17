import { useEffect, useMemo, useState } from 'react';
import Explorer from './views/Explorer';
import Library from './views/Library';
import Settings from './views/Settings';
import ModelModal, { type ModalTarget } from './components/ModelModal';
import { Queue, BootstrapCard, DownloadFloat } from './views/Core';
import Home from './views/Home';
import { MobileNav, Sidebar, Topbar, type Theme, type UpdateState, type ViewId } from './components/chrome';
import {
  addToQueue,
  clearCompleted,
  clearQueue,
  loadQueue,
  removeFromQueue,
} from './lib/queue';
import { adoptServerUser, clearProfile, completeOidcCallback, endSession, fetchServerAuth, hasSession, initials, loadProfile, pullServerProfile, type Profile, type ServerAuthState } from './lib/auth';
import { deleteScanned } from './lib/library';
import { apiPost, backendLogout, backendAvailable } from './lib/backend';
import { pullSettings } from './lib/settings';

export default function App() {
  const [view, setView] = useState<ViewId>('models');
  const [queue, setQueue] = useState(loadQueue);
  const [profile, setProfile] = useState<Profile | null>(loadProfile);
  // Blocking auth gate (mirrors OldCode: no session → no app).
  const [authed, setAuthed] = useState(hasSession() && loadProfile() !== null);
  // When the backend is reachable it owns auth truth (survives new origins).
  const [serverAuth, setServerAuth] = useState<ServerAuthState | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [libKey, setLibKey] = useState(0);
  const [settingsTab, setSettingsTab] = useState('dirs');
  const [appVersion, setAppVersion] = useState('…');
  const [updates, setUpdates] = useState<UpdateState>({ core: false, plugins: false, checking: false });
  const [updating, setUpdating] = useState(false);
  // Models already on disk (backend library + local scan records).
  const [ownedIds, setOwnedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const ids = new Set<string>();
      try {
        const { apiGet, backendAvailable } = await import('./lib/backend');
        if (await backendAvailable()) {
          const r = await apiGet<{ items: Array<{ modelId: number; versionId: number }> }>('/library');
          for (const it of r.items ?? []) ids.add(`${it.modelId}-${it.versionId}`);
        }
      } catch {
        /* standalone */
      }
      try {
        const { loadScanned } = await import('./lib/library');
        for (const s of loadScanned()) {
          if (s.modelId) ids.add(`${s.modelId}-${s.versionId}`);
        }
      } catch {
        /* ignore */
      }
      if (live) setOwnedIds(ids);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // Central post-auth handler: profile state, session flag, then the full
  // server row (avatar/email) so login restores everything refresh would.
  // Also kicks off the automatic update check.
  const handleAuthed = async (p: Profile) => {
    setProfile(p);
    setAuthed(true);
    try {
      const full = await pullServerProfile();
      if (full) setProfile(full);
    } catch {
      /* standalone — local stands */
    }
    void checkUpdates();
  };

  /** Fetch backend version + update state (core, plugin updates, new plugins). */
  const checkUpdates = async () => {
    try {
      const { apiGet, backendAvailable } = await import('./lib/backend');
      if (!(await backendAvailable())) return;
      try {
        const h = await apiGet<{ version?: string }>('/health');
        if (h.version) setAppVersion(h.version);
      } catch {
        /* keep placeholder */
      }
      setUpdates((u) => ({ ...u, checking: true }));
      let core = false;
      try {
        const c = await apiGet<{ total?: number; core?: { has_update?: boolean } }>('/updates/check');
        core = Boolean(c.core?.has_update);
      } catch {
        /* admin-only or offline — plugins still checkable below */
      }
      let plugins = false;
      try {
        const [hub, inst] = await Promise.all([
          (await import('./lib/plugins')).fetchCatalog().then((r) => r.catalog).catch(() => null),
          apiGet<{ installed?: Array<{ id: string; version?: string; has_update?: boolean }> }>('/plugins').catch(
            () => null,
          ),
        ]);
        if (hub) {
          const installed = new Map((inst?.installed ?? []).map((p) => [p.id, p]));
          plugins = hub.plugins.some((p) => {
            const cur = installed.get(p.id);
            if (!cur) return true; // brand-new plugin in the hub
            if (cur.has_update) return true;
            return (cur.version ?? '') !== p.version;
          });
        }
      } catch {
        /* ignore */
      }
      setUpdates({ core, plugins, checking: false });
    } catch {
      setUpdates((u) => ({ ...u, checking: false }));
    }
  };

  const updateCore = async () => {
    setUpdating(true);
    try {
      const { apiPost } = await import('./lib/backend');
      await apiPost('/updates/core', {});
      await checkUpdates();
    } catch {
      /* message surfaces on next check */
    } finally {
      setUpdating(false);
    }
  };
  const [creatorSearch, setCreatorSearch] = useState<{ token: number; text: string }>({
    token: 0,
    text: '',
  });
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('sdcodex.theme.v1') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const queuedIds = useMemo(() => new Set(queue.map((i) => i.id)), [queue]);

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    try {
      localStorage.setItem('sdcodex.theme.v1', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // If the backend is up, its SQLite rows win over the local cache.
  // Server settings pull only once authenticated (/api/settings is 401 anon).
  const [callbackMsg, setCallbackMsg] = useState<string | null>(null);
  const refreshServerAuth = async () => {    const s = await fetchServerAuth();
    if (s) {
      setServerAuth(s);
      if (s.user && s.authed) {
        const adopted = adoptServerUser(s.user);
        if (adopted) {
          setProfile(adopted);
          const full = await pullServerProfile();
          if (full) setProfile(full);
        }
      }
    }
  };
  useEffect(() => {
    void (async () => {
      // SSO return path: provider redirects here with ?code&state.
      if (window.location.pathname === '/auth/oidc/callback') {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const state = params.get('state');
        window.history.replaceState(null, '', '/');
          if (code && state) {
            try {
              const adopted = await completeOidcCallback(code, state);
              await handleAuthed(adopted);
              setServerAuth({ authed: true, bootstrap: false, user: null });
            } catch (e) {
            setCallbackMsg(e instanceof Error ? e.message : 'SSO sign-in failed');
          }
        } else if (params.get('error')) {
          setCallbackMsg(`Provider refused: ${params.get('error_description') || params.get('error')}`);
        }
      }
      // Backend owns auth truth when reachable: adopt its user/session so a
      // fresh origin (new port, cleared storage) signs in instead of
      // re-bootstrapping while accounts exist server-side.
      const s = await fetchServerAuth();
      if (s) {
        setServerAuth(s);
        if (s.user) {
          const adopted = adoptServerUser(s.user);
          if (adopted) setProfile(adopted);
          if (s.authed) {
            setAuthed(true);
            // Full profile (avatar/email) lives behind /profile — pull it so a
            // refresh never shows stale local rows.
            const full = await pullServerProfile();
            if (full) setProfile(full);
            void checkUpdates();
          } else {
            setAuthed(hasSession() && loadProfile() !== null);
          }
        } else {
          setAuthed(false);
        }
      }
      setAuthReady(true);
    })();
  }, []);

  // Server settings pull once a session exists (/api/settings is 401 anon —
  // pulling pre-auth only spams the console). Runs on login and on refresh
  // with a live session.
  useEffect(() => {
    if (authed) void pullSettings();
  }, [authed]);

  // Global "/" focuses the first search field, as placeholders promise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const el = document.querySelector<HTMLInputElement>('[data-search]');
      if (el) {
        e.preventDefault();
        el.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (v: ViewId) => {
    setModal(null);
    setView(v);
  };

  const goSettings = (tab: string) => {
    setSettingsTab(tab);
    setModal(null);
    setView('settings');
  };

  // Single queue entry point: local staged record + backend worker POST.
  // Every Download button (Explorer, Home, modal) funnels through here.
  const enqueue = (item: {
    id: string;
    name: string;
    detail: string;
    downloadUrl: string;
    modelId: number;
    versionId: number;
    baseModel: string;
  }) => {
    setQueue(addToQueue(item));
    if (item.modelId && item.versionId) {
      void (async () => {
        try {
          if (await backendAvailable()) {
            await apiPost('/downloads', {
              modelId: item.modelId,
              versionId: item.versionId,
            });
          }
        } catch {
          /* worker offline — local stub keeps the entry */
        }
      })();
    }
  };

  return (
    <div className="min-h-screen bg-obsidian-bg text-ink">
      <DownloadFloat go={() => go('queue')} />
      {callbackMsg && (
        <div className="fixed left-1/2 top-4 z-[70] -translate-x-1/2 rounded-lg border border-status-alert/40 bg-status-alert/15 px-4 py-2 font-mono text-xs text-[#f87171]">
          SSO: {callbackMsg}
          <button type="button" onClick={() => setCallbackMsg(null)} className="ml-3 underline">
            dismiss
          </button>
        </div>
      )}
      {!authReady && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <p className="font-mono text-xs text-ink-faint">Checking session…</p>
        </div>
      )}
      {authReady && !authed && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="glass-l2 edge-shimmer w-full max-w-md rounded-lg p-5">
            <div className="mt-2">
              <BootstrapCard
                existing={serverAuth && !serverAuth.bootstrap ? profile : serverAuth ? null : profile}
                serverMode={serverAuth !== null}
                serverBootstrap={serverAuth?.bootstrap ?? true}
                onServerChanged={() => {
                  void refreshServerAuth();
                }}
                onSwitchUser={() => {
                  clearProfile();
                  setProfile(null);
                }}
                onDone={(p) => {
                  void handleAuthed(p);
                }}
              />
            </div>
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-[1400px]">
        <Sidebar
          view={view}
          go={go}
          queueCount={queue.length}
          version={appVersion}
          updates={updates}
          updating={updating}
          onUpdateCore={() => void updateCore()}
          onGoPlugins={() => goSettings('plugins')}
        />

        <main className="min-w-0 flex-1 p-4 md:p-5">
          <MobileNav view={view} go={go} />
          <Topbar
            go={go}
            theme={theme}
            setTheme={setTheme}
            profileLabel={initials(profile)}
            avatarUrl={profile?.avatar ?? ''}
            signedIn={authed}
            onSignOut={() => {
              void backendLogout();
              endSession();
              setAuthed(false);
            }}
          />

          {view === 'home' && (
            <Home
              goModels={() => go('models')}
              onOpen={(id) => setModal({ kind: 'civitai', modelId: id })}
              onQueue={enqueue}
              queuedIds={queuedIds}
              ownedIds={ownedIds}
            />
          )}
          {view === 'models' && (
            <Explorer
              queuedIds={queuedIds}
              ownedIds={ownedIds}
              onQueue={enqueue}
              onOpen={(id) => setModal({ kind: 'civitai', modelId: id })}
              searchToken={creatorSearch.token}
              searchText={creatorSearch.text}
            />
          )}
          {view === 'library' && <Library key={libKey} onOpen={(t) => setModal(t)} />}
          {view === 'queue' && (
            <Queue
              items={queue}
              onRemove={(id) => setQueue(removeFromQueue(id))}
              onClearCompleted={() => setQueue(clearCompleted())}
              onClearAll={() => setQueue(clearQueue())}
            />
          )}
          {view === 'settings' && (
            <Settings
              key={settingsTab}
              initialTab={settingsTab}
              profile={profile}
              onProfile={setProfile}
              onSignOut={() => setAuthed(false)}
            />
          )}
        </main>
      </div>

      {modal && (
        <ModelModal
          target={modal}
          onClose={() => setModal(null)}
          queuedIds={queuedIds}
          ownedIds={ownedIds}
          onQueue={enqueue}
          onSearchCreator={(username) => {
            setModal(null);
            setView('models');
            setCreatorSearch((s) => ({ token: s.token + 1, text: username }));
          }}
          onForgetLocal={(modelId, versionId) => {
            deleteScanned(modelId, versionId);
            setLibKey((k) => k + 1);
          }}
          onLibraryChanged={() => setLibKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
