import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BASE_MODELS,
  MODEL_TYPES,
  SORTS,
  fetchModels,
  formatCount,
  probeCivitai,
  type CivitaiModel,
  type ExplorerQuery,
} from '../lib/civitai';
import { targetDirFor } from '../lib/settings';
import { Stars, TypeBadge } from '../components/ui';
import {
  BaseCloud,
  GhostButton,
  PageHeader,
  PrimaryButton,
  SearchInput,
} from '../components/chrome';

interface Props {
  onQueue: (item: {
    id: string;
    name: string;
    detail: string;
    downloadUrl: string;
    modelId: number;
    versionId: number;
    baseModel: string;
  }) => void;
  queuedIds: Set<string>;
  ownedIds: Set<string>;
  onOpen: (modelId: number) => void;
  searchToken: number;
  searchText: string;
}

function isNsfwImage(img: { nsfwLevel: number }): boolean {
  // nsfwLevel 1 = safe, anything above = soft/mature/explicit/blocked
  return img.nsfwLevel > 1;
}

export default function Explorer({ onQueue, queuedIds, ownedIds, onOpen, searchToken, searchText }: Props) {
  const [query, setQuery] = useState<ExplorerQuery>({
    q: '',
    type: 'All',
    baseModels: [],
    sort: 'Highest Rated',
    nsfw: false,
  });
  const [draft, setDraft] = useState('');
  const [items, setItems] = useState<CivitaiModel[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalItems, setTotalItems] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [blurNsfw, setBlurNsfw] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);
  const [apiLive, setApiLive] = useState<boolean | null>(null);

  const initialAbortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadInitial = useCallback(async (q: ExplorerQuery) => {
    initialAbortRef.current?.abort();
    moreAbortRef.current?.abort();
    const ctl = new AbortController();
    initialAbortRef.current = ctl;

    setLoadingInitial(true);
    setLoadingMore(false);
    setInitialError(null);
    setLoadMoreError(null);

    const t0 = performance.now();
    try {
      const data = await fetchModels({ ...q, page: 1, cursor: undefined }, ctl.signal);
      setItems(data.items);
      setNextCursor(data.nextCursor);
      setCurrentPage(data.currentPage);
      setTotalItems(data.totalItems > 0 ? data.totalItems : null);

      const more =
        data.items.length > 0 &&
        (Boolean(data.nextCursor) || data.currentPage < data.totalPages);
      setHasMore(more);
      setLatency(Math.round(performance.now() - t0));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setInitialError(e instanceof Error ? e.message : 'Request failed');
      }
    } finally {
      if (!ctl.signal.aborted) {
        setLoadingInitial(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingInitial || loadingMore || !hasMore || loadMoreError) return;

    moreAbortRef.current?.abort();
    const ctl = new AbortController();
    moreAbortRef.current = ctl;

    setLoadingMore(true);
    setLoadMoreError(null);

    const t0 = performance.now();
    try {
      const nextPage = currentPage + 1;
      const data = await fetchModels(
        {
          ...query,
          page: nextPage,
          cursor: nextCursor,
        },
        ctl.signal,
      );

      setItems((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const added = data.items.filter((m) => !seen.has(m.id));
        return [...prev, ...added];
      });

      setNextCursor(data.nextCursor);
      setCurrentPage(data.currentPage);
      if (data.totalItems > 0) setTotalItems(data.totalItems);

      const more =
        data.items.length > 0 &&
        (Boolean(data.nextCursor) || data.currentPage < data.totalPages);
      setHasMore(more);
      setLatency(Math.round(performance.now() - t0));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setLoadMoreError(e instanceof Error ? e.message : 'Failed to load next page');
      }
    } finally {
      if (!ctl.signal.aborted) {
        setLoadingMore(false);
      }
    }
  }, [loadingInitial, loadingMore, hasMore, loadMoreError, currentPage, query, nextCursor]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  // Infinite scroll trigger via IntersectionObserver
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loadMoreError) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMoreRef.current();
        }
      },
      { root: null, rootMargin: '600px 0px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, items.length, loadMoreError]);

  // Passive window scroll listener as a secondary safeguard
  useEffect(() => {
    if (!hasMore || loadMoreError) return;

    const onScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop;
      const windowHeight = window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;

      if (documentHeight - (scrollY + windowHeight) < 600) {
        loadMoreRef.current();
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [hasMore, loadMoreError]);

  useEffect(() => {
    loadInitial(query);
    return () => {
      initialAbortRef.current?.abort();
      moreAbortRef.current?.abort();
    };
  }, [query, loadInitial]);

  // Liveness probe drives the status badge (static green lied when down).
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await probeCivitai();
      if (live) {
        setApiLive(r.ok);
        if (r.ms !== null) setLatency((l) => l ?? r.ms);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Deep-link from detail view (creator search): external search requests.
  const lastToken = useRef(0);
  useEffect(() => {
    if (searchToken !== lastToken.current) {
      lastToken.current = searchToken;
      setDraft(searchText);
      patch({ q: searchText });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchToken]);

  const patch = (p: Partial<ExplorerQuery>) =>
    setQuery((q) => ({ ...q, ...p }));

  return (
    <div>
      <PageHeader
        title="Model Explorer"
        subtitle="Browse Civitai weights by base model, architecture, and tags."
        meta={
          <>
            <span
              className={`mr-2 inline-flex items-center gap-1.5 rounded border px-2 py-0.5 ${
                apiLive === false
                  ? 'border-status-alert/30 bg-status-alert/10 text-[#f87171]'
                  : 'border-status-active/30 bg-status-active/10 text-status-active'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${apiLive === false ? 'bg-status-alert' : 'bg-status-active'}`}
              />
              {apiLive === false ? 'Civitai API unreachable' : 'Civitai API'}
            </span>
            {loadingInitial ? (
              'Searching…'
            ) : (
              <>
                {totalItems !== null
                  ? `Showing ${items.length} of ${formatCount(totalItems)} indexed`
                  : `Showing ${items.length} models`}
                {latency !== null ? ` · ${latency}ms` : ''}
              </>
            )}
          </>
        }
      />

      <div className="glass-l1 edge-shimmer mt-4 rounded-lg p-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            patch({ q: draft });
          }}
        >
          <SearchInput
            value={draft}
            onChange={setDraft}
            placeholder="Search 14k+ weights…  ( / )"
          />
          <PrimaryButton type="submit">Search</PrimaryButton>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
              Type:
            </span>
            <select
              value={query.type}
              onChange={(e) => patch({ type: e.target.value })}
              className="rounded border border-white/10 bg-obsidian-lowest px-2 py-1 text-xs outline-none focus:border-primary"
            >
              {['All', ...MODEL_TYPES].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
              Sort:
            </span>
            <select
              value={query.sort}
              onChange={(e) => patch({ sort: e.target.value as ExplorerQuery['sort'] })}
              className="rounded border border-white/10 bg-obsidian-lowest px-2 py-1 text-xs outline-none focus:border-primary"
            >
              {SORTS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>

          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">
            <input
              type="checkbox"
              checked={blurNsfw}
              onChange={(e) => setBlurNsfw(e.target.checked)}
              className="accent-[#6366f1]"
            />
            NSFW blur
          </label>
        </div>

        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <BaseCloud
            options={BASE_MODELS}
            active={query.baseModels}
            onToggle={(b) =>
              patch({
                baseModels: query.baseModels.includes(b)
                  ? query.baseModels.filter((x) => x !== b)
                  : [...query.baseModels, b],
              })
            }
            onClear={() => patch({ baseModels: [] })}
          />
        </div>
      </div>

      {initialError && (
        <div className="mt-4 rounded-lg border border-status-alert/40 bg-status-alert/10 p-4 text-sm">
          <span className="font-semibold text-[#f87171]">Explorer unavailable:</span> {initialError}
          <GhostButton className="ml-3" onClick={() => loadInitial(query)}>
            Retry
          </GhostButton>
        </div>
      )}

      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {loadingInitial &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="glass-l1 h-64 animate-pulse rounded-lg" />
          ))}
        {!loadingInitial &&
          items.map((m) => {
            const v = m.modelVersions[0];
            const img = v?.images[0];
            const blur = blurNsfw && img && isNsfwImage(img);
            const queued = v ? queuedIds.has(`civitai-${m.id}-${v.id}`) : queuedIds.has(`civitai-${m.id}`);
            const owned = v ? ownedIds.has(`${m.id}-${v.id}`) : false;
            return (
              <article
                key={m.id}
                className="glass-l1 group overflow-hidden rounded-lg transition-colors hover:border-primary/40"
              >
                <button
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className="block w-full text-left"
                  title="Open model detail"
                >
                  <div className="relative aspect-[4/3] bg-obsidian-lowest">
                    {img ? (
                      <div className="h-full w-full overflow-hidden">
                        <img
                          src={img.url}
                          alt=""
                          loading="lazy"
                          className={`h-full w-full object-cover transition-[filter] ${blur ? 'scale-105 blur-md' : ''}`}
                        />
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-faint">
                        no preview
                      </div>
                    )}
                    <div className="absolute left-2 top-2">
                      <TypeBadge type={m.type} />
                    </div>
                  </div>
                  <div className="p-3 pb-0">
                    <h2 className="truncate font-display text-sm font-semibold group-hover:text-white" title={m.name}>
                      {m.name}
                    </h2>
                  </div>
                </button>
                <div className="p-3 pt-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px] text-ink-muted">
                    <Stars rating={m.stats?.rating ?? 0} />
                    <span>{formatCount(m.stats?.downloadCount ?? 0)} DL</span>
                    <span className="truncate text-ink-faint">@{m.creator?.username ?? '—'}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                    {targetDirFor(m.type, v?.baseModel ?? query.baseModels[0] ?? 'All')}
                  </div>
                  <button
                    type="button"
                    disabled={queued || owned || !v}
                    onClick={() =>
                      v &&
                      onQueue({
                        id: `civitai-${m.id}-${v.id}`,
                        name: m.name,
                        detail: `${m.type} · ${v.baseModel}`,
                        downloadUrl: v.downloadUrl,
                        modelId: m.id,
                        versionId: v.id,
                        baseModel: v.baseModel,
                      })
                    }
                    className={`mt-2 w-full rounded border py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] ${
                      queued || owned
                        ? 'border-status-active/40 bg-status-active/10 text-status-active'
                        : 'border-primary/50 bg-primary/20 text-white hover:bg-primary/30 disabled:opacity-50'
                    }`}
                  >
                    {queued ? '✓ Queued' : owned ? '✓ Installed' : '+ Download queue'}
                  </button>
                </div>
              </article>
            );
          })}
        {!loadingInitial &&
          loadingMore &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`more-sk-${i}`} className="glass-l1 h-64 animate-pulse rounded-lg" />
          ))}
      </section>

      {!loadingInitial && items.length === 0 && !initialError && (
        <div className="mt-8 rounded-lg border border-white/[0.06] bg-obsidian-lowest/40 py-16 text-center">
          <p className="font-display text-base font-semibold text-ink">No models found</p>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            Try adjusting your search query, type, or base model filters.
          </p>
        </div>
      )}

      {loadMoreError && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-status-alert/40 bg-status-alert/10 p-3 text-xs">
          <div className="text-[#f87171]">
            <span className="font-semibold">Failed to load more models:</span> {loadMoreError}
          </div>
          <GhostButton
            onClick={() => {
              setLoadMoreError(null);
              void loadMore();
            }}
          >
            Retry
          </GhostButton>
        </div>
      )}

      {loadingMore && (
        <div className="mt-4 flex items-center justify-center gap-2 font-mono text-xs text-ink-muted">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading more models…
        </div>
      )}

      {/* Sentinel for infinite scroll */}
      {hasMore && !loadMoreError && (
        <div ref={sentinelRef} className="h-10 w-full" aria-hidden="true" />
      )}

      {!loadingInitial && !hasMore && items.length > 0 && (
        <div className="mt-8 py-4 text-center font-mono text-xs text-ink-faint">
          All {totalItems ? `${formatCount(totalItems)} ` : `${items.length} `}models loaded
        </div>
      )}
    </div>
  );
}
