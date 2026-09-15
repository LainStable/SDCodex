import { useEffect, useMemo, useState } from 'react';
import Detail from './views/Detail';
import Explorer from './views/Explorer';
import Library from './views/Library';
import Settings from './views/Settings';
import { Home, Plugins, Queue } from './views/Core';
import { MobileNav, Sidebar, Topbar, type Theme, type ViewId } from './components/chrome';
import {
  addToQueue,
  clearCompleted,
  clearQueue,
  loadQueue,
} from './lib/queue';
import { clearProfile, initials, loadProfile, type Profile } from './lib/auth';

export default function App() {
  const [view, setView] = useState<ViewId>('models');
  const [queue, setQueue] = useState(loadQueue);
  const [profile, setProfile] = useState<Profile | null>(loadProfile);
  const [detailId, setDetailId] = useState<number | null>(null);
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
    setDetailId(null);
    setView(v);
  };

  return (
    <div className="min-h-screen bg-obsidian-bg text-ink">
      <div className="mx-auto flex max-w-[1400px]">
        <Sidebar view={view} go={go} queueCount={queue.length} />

        <main className="min-w-0 flex-1 p-4 md:p-5">
          <MobileNav view={view} go={go} />
          <Topbar
            go={go}
            theme={theme}
            setTheme={setTheme}
            profileLabel={initials(profile)}
            signedIn={profile !== null}
            onSignOut={() => {
              clearProfile();
              setProfile(null);
            }}
          />

          {detailId !== null ? (
            <Detail
              modelId={detailId}
              onBack={() => setDetailId(null)}
              onSearchCreator={(username) => {
                setDetailId(null);
                setView('models');
                setCreatorSearch((s) => ({ token: s.token + 1, text: username }));
              }}
              queuedIds={queuedIds}
              onQueue={(item) => setQueue(addToQueue(item))}
            />
          ) : (
            <>
              {view === 'home' && <Home go={go} />}
              {view === 'models' && (
                <Explorer
                  queuedIds={queuedIds}
                  onQueue={(item) => setQueue(addToQueue(item))}
                  onOpen={setDetailId}
                  searchToken={creatorSearch.token}
                  searchText={creatorSearch.text}
                />
              )}
              {view === 'library' && <Library />}
              {view === 'queue' && (
                <Queue
                  items={queue}
                  onClearCompleted={() => setQueue(clearCompleted())}
                  onClearAll={() => setQueue(clearQueue())}
                />
              )}
              {view === 'plugins' && <Plugins />}
          {view === 'settings' && <Settings profile={profile} onProfile={setProfile} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
