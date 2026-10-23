import { useEffect, useMemo, useState } from 'react';
import Explorer from './views/Explorer';
import Library from './views/Library';
import Settings from './views/Settings';
import PluginView from './views/PluginView';
import ModelModal, { type ModalTarget } from './components/ModelModal';
import { Queue, BootstrapCard, DownloadFloat, PluginTaskFloat, ScanFloat } from './views/Core';
import Home from './views/Home';
import { MobileNav, Sidebar, Topbar, type UpdateState, type ViewId } from './components/chrome';
import {
  addToQueue,
  clearCompleted,
  clearQueue,
  loadQueue,
  removeFromQueue,
} from './lib/queue';
import { adoptServerUser, clearProfile, completeOidcCallback, endSession, fetchServerAuth, hasSession, initials, loadProfile, pullServerProfile, type Profile, type ServerAuthState } from './lib/auth';
import type { InstalledPlugin } from './lib/plugins';
import type { AssistantAction, AssistantSearchParams } from './lib/assistant';
import { deleteScanned } from './lib/library';
import { loadTheme, saveThemePayload, themeClass, THEME_CHANGED_EVENT, THEMES } from './lib/themes';
import { apiPost, backendLogout, backendAvailable } from './lib/backend';
import { getApiKey, pullSettings, setApiUser } from './lib/settings';
import { fetchMe } from './lib/civitai';

type AppRoute = {
  view: ViewId;
  space: { kind: 'core' } | { kind: 'plugin'; id: string };
  pluginPage: string | null;
  settingsTab: string;
};

const viewIds: ViewId[] = ['home', 'models', 'library', 'queue', 'settings'];

function readRoute(): AppRoute {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get('view') as ViewId | null;
  const pluginId = params.get('plugin');
  let savedView: ViewId | null = null;
  try {
    const raw = localStorage.getItem('sdcodex.last-route.v1');
    if (raw) {
      const saved = JSON.parse(raw) as { view?: string; plugin?: string; page?: string | null; tab?: string };
      if (saved.view && viewIds.includes(saved.view as ViewId)) savedView = saved.view as ViewId;
    }
  } catch {
    /* ignore */
  }
  return {
    view: requestedView && viewIds.includes(requestedView) ? requestedView : (savedView ?? 'models'),
    space: pluginId ? { kind: 'plugin', id: pluginId } : { kind: 'core' },
    pluginPage: params.get('page') ?? (pluginId ? (JSON.parse(localStorage.getItem('sdcodex.last-route.v1') || '{}') as Record<string, unknown>).page as string | null ?? null : null),
    settingsTab: ((params.get('tab') || (JSON.parse(localStorage.getItem('sdcodex.last-route.v1') || '{}') as Record<string, unknown>).tab) as string | undefined) ?? 'dirs',
  };
}

function writeRoute(route: AppRoute, replace = false) {
  try {
    localStorage.setItem('sdcodex.last-route.v1', JSON.stringify({
      view: route.view,
      plugin: route.space.kind === 'plugin' ? route.space.id : undefined,
      page: route.pluginPage,
      tab: route.settingsTab,
    }));
  } catch {
    /* ignore */
  }
  const params = new URLSearchParams();
  params.set('view', route.view);
  if (route.space.kind === 'plugin') {
    params.set('plugin', route.space.id);
    const page = route.pluginPage;
    if (page) params.set('page', page);
  } else if (route.view === 'settings' && route.settingsTab !== 'dirs') {
    params.set('tab', route.settingsTab);
  }
  const url = `${window.location.pathname}?${params.toString()}`;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
}

function versionIsNewer(remote: string, local: string): boolean {
  const parts = (value: string) => value.split(/[.+-]/, 1)[0].split('.').map((n) => Number(n) || 0);
  const r = parts(remote);
  const l = parts(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const delta = (r[i] ?? 0) - (l[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

export default function App() {
  const [view, setView] = useState<ViewId>(() => readRoute().view);
  const [queue, setQueue] = useState(loadQueue);
  const [profile, setProfile] = useState<Profile | null>(loadProfile);
  // Blocking auth gate (mirrors OldCode: no session → no app).
  const [authed, setAuthed] = useState(hasSession() && loadProfile() !== null);
  // When the backend is reachable it owns auth truth (survives new origins).
  const [serverAuth, setServerAuth] = useState<ServerAuthState | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [libKey, setLibKey] = useState(0);
  const [settingsTab, setSettingsTab] = useState(() => readRoute().settingsTab);
  // Bumped on every programmatic nav to Settings so the badge re-click
  // remounts the tab (re-running its check) even when already there.
  const [settingsNonce, setSettingsNonce] = useState(0);
  const [appVersion, setAppVersion] = useState('…');
  const [installMode, setInstallMode] = useState<'docker' | 'local'>('local');
  const [updates, setUpdates] = useState<UpdateState>({
    core: false,
    plugins: false,
    newPluginAvailable: false,
    checking: false,
  });
  // Plugin spaces: core views vs one installed plugin (sidebar swaps, fan
  // gains core + per-plugin icons once anything is installed).
  const [space, setSpace] = useState<AppRoute['space']>(() => readRoute().space);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [pluginPage, setPluginPage] = useState<string | null>(() => readRoute().pluginPage);
  // The sidebar is a hover-expanding icon rail; pinning keeps it open.
  const [sidebarPinned, setSidebarPinned] = useState(() => {
    try {
      return localStorage.getItem('sdcodex.sidebar-pinned.v1') === 'true';
    } catch {
      return false;
    }
  });
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
    // Restore the user's server-saved Civitai key before mounting Explorer;
    // otherwise its first request can race this settings fetch and get 401.
    await pullSettings();
    setAuthed(true);
    try {
      const full = await pullServerProfile();
      if (full) setProfile(full);
    } catch {
      /* standalone — local stands */
    }
    void refreshInstalled();
  };

  /** Fetch backend version + update state (core, plugin updates, new plugins). */
  const checkUpdates = async () => {
    try {
      const { apiGet, backendAvailable } = await import('./lib/backend');
      if (!(await backendAvailable())) return;
      let currentVersion = appVersion;
      try {
        const h = await apiGet<{ version?: string }>('/health');
        if (h.version) {
          currentVersion = h.version;
          setAppVersion(h.version);
        }
      } catch {
        /* keep placeholder */
      }
      setUpdates((u) => ({ ...u, checking: true }));
      let core = false;
      let hub: import('./lib/plugins').HubCatalog | null = null;
      try {
        const catalog = await (await import('./lib/plugins')).fetchCatalog();
        if (catalog.live) hub = catalog.catalog;
      } catch {
        /* backend endpoint fallback below */
      }
      if (hub?.core?.version && currentVersion && currentVersion !== '…') {
        core = versionIsNewer(hub.core.version, currentVersion);
      }
      try {
        const c = await apiGet<{ total?: number; core?: { has_update?: boolean } }>('/updates/check');
        core ||= Boolean(c.core?.has_update);
      } catch {
        /* admin-only or offline — plugins still checkable below */
      }
      let plugins = false;
      let newPluginAvailable = false;
      try {
        const inst = await apiGet<{ installed?: Array<{ id: string; version?: string; has_update?: boolean }> }>('/plugins');
        if (hub && Array.isArray(inst.installed)) {
          const installed = new Map(inst.installed.map((p) => [p.id, p]));
          newPluginAvailable = hub.plugins.some((p) => !installed.has(p.id));
          plugins = hub.plugins.some((p) => {
            const cur = installed.get(p.id);
            return Boolean(cur && (cur.has_update || (cur.version ?? '') !== p.version));
          });
        }
      } catch {
        /* ignore */
      }
      setUpdates({ core, plugins, newPluginAvailable, checking: false });
    } catch {
      setUpdates((u) => ({ ...u, checking: false }));
    }
  };

  const [creatorSearch, setCreatorSearch] = useState<{
    token: number;
    text: string;
    spec?: AssistantSearchParams | null;
  }>({
    token: 0,
    text: '',
    spec: null,
  });
  const [assistantStatus, setAssistantStatus] = useState<{ configured: boolean; model: string }>({
    configured: false,
    model: '',
  });
  // Named theme from themes.md (picked at account creation or in Settings →
  // Profile). There is no system default: an account always has a theme.
  const [mdTheme, setMdTheme] = useState<string>(() => loadTheme());
  const queuedIds = useMemo(() => new Set(queue.map((i) => i.id)), [queue]);

  useEffect(() => {
    const root = document.documentElement;
    // Drop any previous named theme first.
    for (const t of THEMES) root.classList.remove(themeClass(t.slug));
    root.classList.remove('light');
    root.classList.add(themeClass(mdTheme));
    root.style.colorScheme = THEMES.find((t) => t.slug === mdTheme)?.mode ?? 'dark';
    // Plugin iframes are separate documents: hand them the resolved palette.
    saveThemePayload(mdTheme);
  }, [mdTheme]);

  // Profile theme picker saves + broadcasts; pick it up live.
  useEffect(() => {
    const onTheme = () => setMdTheme(loadTheme());
    window.addEventListener(THEME_CHANGED_EVENT, onTheme);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onTheme);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('sdcodex.sidebar-pinned.v1', String(sidebarPinned));
    } catch {
      /* ignore */
    }
  }, [sidebarPinned]);

  useEffect(() => {
    const onPopState = () => {
      const route = readRoute();
      setView(route.view);
      setSpace(route.space);
      setPluginPage(route.pluginPage);
      setSettingsTab(route.settingsTab);
      setModal(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
            // Full profile (avatar/email) lives behind /profile — pull it so a
            // refresh never shows stale local rows.
            const full = await pullServerProfile();
            if (full) setProfile(full);
            // Do this before authReady removes the startup gate and mounts
            // Explorer, so its first request includes the restored API key.
            await pullSettings();
            setAuthed(true);
            void refreshInstalled();
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
    if (!authed) return;
    let live = true;
    void (async () => {
      await pullSettings();
      const key = getApiKey();
      if (!key) return;
      try {
        const me = await fetchMe(key);
        if (live) setApiUser(me.username ?? '');
      } catch {
        // Keep the key during outages, but don't report an unverified session.
        if (live) setApiUser('');
      }
    })();
    return () => { live = false; };
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    let live = true;
    const refreshInstallMode = async () => {
      try {
        const { apiGet } = await import('./lib/backend');
        const status = await apiGet<{ mode?: 'docker' | 'local' }>('/system/install-mode');
        if (live && (status.mode === 'docker' || status.mode === 'local')) {
          setInstallMode(status.mode);
        }
      } catch {
        // Keep the local fallback when the backend mode endpoint is unavailable.
      }
    };
    const onInstallModeChanged = () => void refreshInstallMode();
    void refreshInstallMode();
    window.addEventListener('sdcodex:install-mode-changed', onInstallModeChanged);
    return () => {
      live = false;
      window.removeEventListener('sdcodex:install-mode-changed', onInstallModeChanged);
    };
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

  // Assistant presence drives the topbar search box: configured => chat bar.
  useEffect(() => {
    if (!authed) return;
    let live = true;
    const refresh = async () => {
      try {
        const { getAssistantStatus } = await import('./lib/assistant');
        const status = await getAssistantStatus();
        if (live) {
          setAssistantStatus({
            configured: Boolean(status.configured),
            model: status.configured ? status.model : '',
          });
        }
      } catch {
        if (live) setAssistantStatus({ configured: false, model: '' });
      }
    };
    void refresh();
    window.addEventListener('sdcodex:assistant-changed', refresh);
    return () => {
      live = false;
      window.removeEventListener('sdcodex:assistant-changed', refresh);
    };
  }, [authed]);

  // Plugin installs/uninstalls refresh spaces everywhere.
  useEffect(() => {
    const onChange = () => void refreshInstalled();
    window.addEventListener('sdcodex:plugins-changed', onChange);
    return () => window.removeEventListener('sdcodex:plugins-changed', onChange);
  }, []);

  const go = (v: ViewId) => {
    setModal(null);
    setSpace({ kind: 'core' });
    setPluginPage(null);
    setView(v);
    writeRoute({ view: v, space: { kind: 'core' }, pluginPage: null, settingsTab });
  };

  const assistantAction = (action: AssistantAction) => {
    if (action.type !== 'search') return;
    setModal(null);
    setSpace({ kind: 'core' });
    setPluginPage(null);
    setView('models');
    writeRoute({ view: 'models', space: { kind: 'core' }, pluginPage: null, settingsTab });
    setCreatorSearch((prev) => ({
      token: prev.token + 1,
      text: action.params.q ?? '',
      spec: action.params,
    }));
  };

  const goSettings = (tab: string) => {
    setSettingsTab(tab);
    setSettingsNonce((n) => n + 1);
    setModal(null);
    setSpace({ kind: 'core' });
    setPluginPage(null);
    setView('settings');
    writeRoute({ view: 'settings', space: { kind: 'core' }, pluginPage: null, settingsTab: tab });
  };

  const openPluginSpace = (id: string) => {
    setModal(null);
    const plugin = installed.find((item) => item.id === id);
    const page = plugin?.nav_items[0]?.page ?? plugin?.entry_page ?? null;
    setPluginPage(page);
    setSpace({ kind: 'plugin', id });
    writeRoute({ view, space: { kind: 'plugin', id }, pluginPage: page, settingsTab });
  };

  const openCoreSpace = () => {
    setSpace({ kind: 'core' });
    setPluginPage(null);
    writeRoute({ view, space: { kind: 'core' }, pluginPage: null, settingsTab });
  };

  /** Jump from the floating task panel straight to the plugin running it. */
  const openPluginTask = (id: string, page: string) => {
    setModal(null);
    setPluginPage(page || null);
    setSpace({ kind: 'plugin', id });
    writeRoute({ view, space: { kind: 'plugin', id }, pluginPage: page || null, settingsTab });
  };

  const navigatePluginPage = (page: string) => {
    setPluginPage(page);
    if (space.kind === 'plugin') {
      writeRoute({ view, space, pluginPage: page, settingsTab });
    }
  };

  /** Installed plugin spaces (fan icons, sidebar, settings tabs). */
  const refreshInstalled = async () => {
    const { fetchInstalled } = await import('./lib/plugins');
    const list = await fetchInstalled();
    setInstalled(list);
    void checkUpdates();
    // Drop the space if its plugin went away.
    setSpace((s) => (s.kind === 'plugin' && !list.some((p) => p.id === s.id) ? { kind: 'core' } : s));
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
      <div className="fixed bottom-3 right-3 z-[55] flex w-[min(360px,92vw)] flex-col gap-2">
        <DownloadFloat go={() => go('queue')} />
        <ScanFloat onOpen={() => goSettings('dirs')} />
        <PluginTaskFloat onOpen={openPluginTask} />
      </div>
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
                onDone={(p) => {
                  void handleAuthed(p);
                }}
              />
            </div>
          </div>
        </div>
      )}
      <div className="flex min-h-dvh w-full max-w-none">
        <Sidebar
          view={view}
          go={go}
          pinned={sidebarPinned}
          onTogglePin={() => setSidebarPinned((pinned) => !pinned)}
          queueCount={queue.length}
          version={appVersion}
          updates={updates}
          onGoPlugins={() => goSettings('plugins')}
          space={space}
          plugins={installed}
          pluginPage={pluginPage}
          onPluginPage={navigatePluginPage}
        />

        <main className="min-w-0 flex-1 p-4 md:p-5">
          <MobileNav view={view} go={go} />
          <Topbar
            installMode={installMode}
            go={go}
            profileLabel={initials(profile)}
            avatarUrl={profile?.avatar ?? ''}
            signedIn={authed}
            onSignOut={() => {
              void backendLogout();
              clearProfile();
              endSession();
              setProfile(null);
              setAuthed(false);
            }}
            space={space}
            plugins={installed}
            onSpaceCore={openCoreSpace}
            onSpacePlugin={openPluginSpace}
            assistant={{
              configured: assistantStatus.configured,
              model: assistantStatus.model,
              onAction: assistantAction,
            }}
          />

          {space.kind === 'plugin'
            ? (() => {
                const plugin = installed.find((q) => q.id === (space as { id: string }).id);
                return plugin ? (
                  <PluginView plugin={plugin} page={pluginPage} />
                ) : (
                  <p className="font-mono text-xs text-ink-faint">Plugin not installed.</p>
                );
              })()
            : null}
          {space.kind === 'core' && view === 'home' && (
            <Home
              goModels={() => go('models')}
              onOpen={(id) => setModal({ kind: 'civitai', modelId: id })}
              onQueue={enqueue}
              queuedIds={queuedIds}
              ownedIds={ownedIds}
            />
          )}
          {space.kind === 'core' && view === 'models' && (
            <Explorer
              queuedIds={queuedIds}
              ownedIds={ownedIds}
              onQueue={enqueue}
              onOpen={(id) => setModal({ kind: 'civitai', modelId: id })}
              searchToken={creatorSearch.token}
              searchText={creatorSearch.text}
              searchSpec={creatorSearch.spec ?? null}
            />
          )}
          {space.kind === 'core' && view === 'library' && <Library key={libKey} onOpen={(t) => setModal(t)} />}
          {space.kind === 'core' && view === 'queue' && (
            <Queue
              items={queue}
              onRemove={(id) => setQueue(removeFromQueue(id))}
              onClearCompleted={() => setQueue(clearCompleted())}
              onClearAll={() => setQueue(clearQueue())}
            />
          )}
          {space.kind === 'core' && view === 'settings' && (
            <Settings
              key={`${settingsTab}:${settingsNonce}`}
              initialTab={settingsTab}
              installed={installed}
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
            go('models');
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
