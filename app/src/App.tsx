import { useEffect, useMemo, useState } from 'react';
import Explorer from './views/Explorer';
import Library from './views/Library';
import Settings from './views/Settings';
import ModelModal, { type ModalTarget } from './components/ModelModal';
import { Home, Plugins, Queue, BootstrapCard } from './views/Core';
import { MobileNav, Sidebar, Topbar, type Theme, type ViewId } from './components/chrome';
import {
  addToQueue,
  clearCompleted,
  clearQueue,
  loadQueue,
} from './lib/queue';
import { adoptServerUser, completeOidcCallback, endSession, fetchServerAuth, hasSession, initials, loadProfile, pullServerProfile, type Profile, type ServerAuthState } from './lib/auth';
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
  const [callbackMsg, setCallbackMsg] = useState<string | null>(null);
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
            setProfile(adopted);
            setAuthed(true);
            setServerAuth({ authed: true, bootstrap: false, user: null });
          } catch (e) {
            setCallbackMsg(e instanceof Error ? e.message : 'SSO sign-in failed');
          }
        } else if (params.get('error')) {
          setCallbackMsg(`Provider refused: ${params.get('error_description') || params.get('error')}`);
        }
      }
      if (await backendAvailable()) await pullSettings();
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

  return (
    <div className="min-h-screen bg-obsidian-bg text-ink">
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
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-secondary">
              SDCodex locked
            </div>
            <div className="mt-2">
              <BootstrapCard
                existing={serverAuth && !serverAuth.bootstrap ? profile : serverAuth ? null : profile}
                serverMode={serverAuth !== null}
                serverBootstrap={serverAuth?.bootstrap ?? true}
                onDone={(p) => {
                  setProfile(p);
                  setAuthed(true);
                }}
              />
            </div>
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-[1400px]">
        <Sidebar view={view} go={go} queueCount={queue.length} />

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

          {view === 'home' && <Home go={go} />}
          {view === 'models' && (
            <Explorer
              queuedIds={queuedIds}
              onQueue={(item) => {
                setQueue(addToQueue(item));
                // Hand the real download to the backend worker when reachable.
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
              }}
              onOpen={(id) => setModal({ kind: 'civitai', modelId: id })}
              searchToken={creatorSearch.token}
              searchText={creatorSearch.text}
            />
          )}
          {view === 'library' && <Library key={libKey} onOpen={(t) => setModal(t)} />}
          {view === 'queue' && (
            <Queue
              items={queue}
              onClearCompleted={() => setQueue(clearCompleted())}
              onClearAll={() => setQueue(clearQueue())}
            />
          )}
          {view === 'plugins' && <Plugins />}
          {view === 'settings' && (
            <Settings
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
          onQueue={(item) => setQueue(addToQueue(item))}
          onSearchCreator={(username) => {
            setModal(null);
            setView('models');
            setCreatorSearch((s) => ({ token: s.token + 1, text: username }));
          }}
          onForgetLocal={(modelId, versionId) => {
            deleteScanned(modelId, versionId);
            setLibKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
