/* Home & Civitai Featured Showcase. All rails come from the live Civitai API:
   hero = highest-rated model, featured = most downloaded, trending strip =
   most-liked previews. */

import { useCallback, useEffect, useState } from 'react';
import {
  fetchModels,
  formatCount,
  type CivitaiModel,
} from '../lib/civitai';
import { loadScanned } from '../lib/library';
import { GhostButton, PrimaryButton } from '../components/chrome';
import { Stars, TypeBadge } from '../components/ui';

interface Rail {
  hero: CivitaiModel | null;
  featured: CivitaiModel[];
  trending: CivitaiModel[];
  total: number;
  latency: number | null;
}

interface Props {
  goModels: () => void;
  onOpen: (modelId: number) => void;
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
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

export default function Home({ goModels, onOpen, onQueue, queuedIds, ownedIds }: Props) {
  const [rail, setRail] = useState<Rail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const t0 = performance.now();
    try {
      const base = { q: '', type: 'All', baseModels: [] as string[], page: 1, nsfw: false };
      const [top, down, liked] = await Promise.all([
        fetchModels({ ...base, sort: 'Highest Rated' }),
        fetchModels({ ...base, sort: 'Most Downloaded' }),
        fetchModels({ ...base, sort: 'Most Liked' }),
      ]);
      setRail({
        hero: top.items[0] ?? null,
        featured: down.items.slice(0, 6),
        trending: liked.items.slice(0, 8),
        total: down.totalItems,
        latency: Math.round(performance.now() - t0),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const localCount = loadScanned().length;
  const hero = rail?.hero ?? null;
  const heroVersion = hero?.modelVersions[0];
  const heroTriggers = (hero?.tags ?? []).slice(0, 6).join(', ');

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-status-alert/40 bg-status-alert/10 p-4 text-sm">
          <span className="font-semibold text-[#f87171]">Showcase unavailable:</span> {error}
          <GhostButton className="ml-3" onClick={() => void load()}>
            Retry
          </GhostButton>
        </div>
      )}

      {!rail && !error && <div className="glass-l1 h-72 animate-pulse rounded-lg" />}

      {hero && (
        <section className="glass-l1 edge-shimmer overflow-hidden rounded-lg">
          <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
            <div className="relative min-h-56 bg-black/40">
              {heroVersion?.images[0] ? (
                <img
                  src={heroVersion.images[0].url}
                  alt=""
                  className="absolute inset-0 h-full w-full cursor-zoom-in object-cover"
                  onClick={() => onOpen(hero.id)}
                />
              ) : (
                <div className="flex h-full items-center justify-center font-mono text-xs text-ink-faint">
                  no preview
                </div>
              )}
            </div>
            <div className="p-4 md:p-5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded border border-secondary/40 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-[#22d3ee]">
                  Community pick
                </span>
                <TypeBadge type={hero.type} />
                {heroVersion && (
                  <span className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                    {heroVersion.name}
                  </span>
                )}
              </div>
              <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">{hero.name}</h1>
              <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
                <Stars rating={hero.stats?.rating ?? 0} />
                <span>({formatCount(hero.stats?.ratingCount ?? 0)} reviews)</span>
                <span>{formatCount(hero.stats?.downloadCount ?? 0)} downloads</span>
                <span className="text-ink-faint">@{hero.creator?.username ?? '—'}</span>
              </div>
              {heroTriggers && (
                <div className="mt-3 rounded border border-white/[0.06] bg-black/30 p-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                    Trigger
                  </div>
                  <div className="mt-1 flex items-start justify-between gap-2">
                    <p className="font-mono text-[11px] text-ink-muted">{heroTriggers}</p>
                    <GhostButton
                      onClick={() => {
                        copyText(heroTriggers);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </GhostButton>
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {heroVersion && (
                  <PrimaryButton
                    disabled={
                      queuedIds.has(`civitai-${hero.id}-${heroVersion.id}`) ||
                      ownedIds.has(`${hero.id}-${heroVersion.id}`)
                    }
                    onClick={() =>
                      onQueue({
                        id: `civitai-${hero.id}-${heroVersion.id}`,
                        name: `${hero.name} · ${heroVersion.name}`,
                        detail: `${hero.type} · ${heroVersion.baseModel}`,
                        downloadUrl: heroVersion.downloadUrl,
                        modelId: hero.id,
                        versionId: heroVersion.id,
                        baseModel: heroVersion.baseModel,
                      })
                    }
                  >
                    {queuedIds.has(`civitai-${hero.id}-${heroVersion.id}`)
                      ? '✓ Queued'
                      : ownedIds.has(`${hero.id}-${heroVersion.id}`)
                        ? '✓ Installed'
                        : '⬇ 1-Click Download'}
                  </PrimaryButton>
                )}
                <GhostButton onClick={() => onOpen(hero.id)}>Explore →</GhostButton>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-px bg-white/[0.06] font-mono text-[11px] sm:grid-cols-4">
            {[
              [`${formatCount(rail?.total ?? 0)}`, 'Models indexed'],
              [`${localCount}`, 'Local cached'],
              [`${rail?.latency ?? '—'}${rail?.latency != null ? 'ms' : ''}`, 'API latency'],
              ['v2.4.0', 'Workstation'],
            ].map(([v, l]) => (
              <div key={l} className="bg-obsidian-bg px-3 py-2">
                <div className="text-sm font-semibold text-ink">{v}</div>
                <div className="text-ink-faint">{l}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-5">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-semibold">Featured Civitai Models</h2>
          <button
            type="button"
            onClick={goModels}
            className="ml-auto font-mono text-[11px] text-secondary hover:underline"
          >
            View all {formatCount(rail?.total ?? 0)} →
          </button>
        </div>
        {!rail && !error && (
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass-l1 h-56 animate-pulse rounded-lg" />
            ))}
          </div>
        )}
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(rail?.featured ?? []).map((m) => {
            const v = m.modelVersions[0];
            const queued = v ? queuedIds.has(`civitai-${m.id}-${v.id}`) : false;
            const owned = v ? ownedIds.has(`${m.id}-${v.id}`) : false;
            return (
              <article
                key={m.id}
                className="glass-l1 group overflow-hidden rounded-lg transition-colors hover:border-primary/40"
              >
                <button type="button" onClick={() => onOpen(m.id)} className="block w-full text-left">
                  <div className="relative aspect-[4/3] bg-obsidian-lowest">
                    {v?.images[0] ? (
                      <img src={v.images[0].url} alt="" loading="lazy" className="h-full w-full object-cover" />
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
                    <h3 className="truncate font-display text-sm font-semibold" title={m.name}>
                      {m.name}
                    </h3>
                  </div>
                </button>
                <div className="flex items-center gap-2 p-3 pt-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] text-ink-muted">
                    <Stars rating={m.stats?.rating ?? 0} />
                    <span>{formatCount(m.stats?.downloadCount ?? 0)} DL</span>
                  </div>
                  {v && (
                    <GhostButton
                      disabled={queued || owned}
                      onClick={() =>
                        onQueue({
                          id: `civitai-${m.id}-${v.id}`,
                          name: `${m.name} · ${v.name}`,
                          detail: `${m.type} · ${v.baseModel}`,
                          downloadUrl: v.downloadUrl,
                          modelId: m.id,
                          versionId: v.id,
                          baseModel: v.baseModel,
                        })
                      }
                    >
                      {queued ? '✓ Queued' : owned ? '✓ Installed' : '⬇ Download'}
                    </GhostButton>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {rail && rail.trending.length > 0 && (
        <section className="mt-5">
          <h2 className="font-display text-lg font-semibold">Trending Community Creations</h2>
          <div className="noscroll mt-2 flex gap-2 overflow-x-auto pb-1">
            {rail.trending.flatMap((m) =>
              (m.modelVersions[0]?.images ?? []).slice(0, 2).map((img, i) => (
                <button
                  key={`${m.id}-${i}`}
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className="h-36 w-28 shrink-0 overflow-hidden rounded-lg border border-white/[0.06] hover:border-primary/40"
                  title={m.name}
                >
                  <img src={img.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                </button>
              )),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
