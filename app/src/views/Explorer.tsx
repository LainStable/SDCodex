import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BASE_MODELS,
  MODEL_TYPES,
  SORTS,
  fetchModels,
  formatCount,
  probeCivitai,
  type CivitaiPage,
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
  onOpen: (modelId: number) => void;
  searchToken: number;
  searchText: string;
}

function isNsfwImage(img: { nsfw: boolean | string }): boolean {
  return img.nsfw === true || (typeof img.nsfw === 'string' && img.nsfw !== 'None');
}

export default function Explorer({ onQueue, queuedIds, onOpen, searchToken, searchText }: Props) {
  const [query, setQuery] = useState<ExplorerQuery>({
    q: '',
    type: 'All',
    baseModels: [],
    sort: 'Highest Rated',
    page: 1,
    nsfw: false,
  });
  const [draft, setDraft] = useState('');
  const [page, setPage] = useState<CivitaiPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blurNsfw, setBlurNsfw] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);
  const [apiLive, setApiLive] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (q: ExplorerQuery) => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    try {
      const data = await fetchModels(q, ctl.signal);
      setPage(data);
      setLatency(Math.round(performance.now() - t0));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : 'Request failed');
      }
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(query);
    return () => abortRef.current?.abort();
  }, [query, load]);

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

  const patch = (p: Partial<ExplorerQuery>, resetPage = true) =>
    setQuery((q) => ({ ...q, ...p, page: resetPage ? 1 : q.page }));

  const shown = page?.items.length ?? 0;
  const total = page?.totalItems ?? 0;

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
            {loading
              ? 'Searching…'
              : `Showing ${shown} of ${formatCount(total)} indexed${latency !== null ? ` · ${latency}ms` : ''}`}
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

      {error && (
        <div className="mt-4 rounded-lg border border-status-alert/40 bg-status-alert/10 p-4 text-sm">
          <span className="font-semibold text-[#f87171]">Explorer unavailable:</span> {error}
          <GhostButton className="ml-3" onClick={() => load(query)}>
            Retry
          </GhostButton>
        </div>
      )}

      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {loading &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="glass-l1 h-64 animate-pulse rounded-lg" />
          ))}
        {!loading &&
          (page?.items ?? []).map((m) => {
            const v = m.modelVersions[0];
          const img = v?.images[0];
          const blur = blurNsfw && img && isNsfwImage(img);
          const queued = v ? queuedIds.has(`civitai-${m.id}-${v.id}`) : queuedIds.has(`civitai-${m.id}`);
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
                    <img
                      src={img.url}
                      alt=""
                      loading="lazy"
                      className={`h-full w-full object-cover ${blur ? 'blur-md' : ''}`}
                    />
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
                  disabled={queued || !v}
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
                    queued
                      ? 'border-status-active/40 bg-status-active/10 text-status-active'
                      : 'border-primary/50 bg-primary/20 text-white hover:bg-primary/30 disabled:opacity-50'
                  }`}
                >
                  {queued ? '✓ Queued' : '+ Download queue'}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {page && page.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 font-mono text-xs">
          <GhostButton
            disabled={query.page <= 1 || loading}
            onClick={() => patch({ page: query.page - 1 }, false)}
          >
            ← Prev
          </GhostButton>
          <span className="text-ink-muted">
            Page {page.currentPage} / {formatCount(page.totalPages)}
          </span>
          <GhostButton
            disabled={query.page >= page.totalPages || loading}
            onClick={() => patch({ page: query.page + 1 }, false)}
          >
            Next →
          </GhostButton>
        </div>
      )}
    </div>
  );
}
