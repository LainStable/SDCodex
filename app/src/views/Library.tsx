import { useMemo, useState } from 'react';
import { MODELS, type ModelKind } from '../data/models';
import { loadScanned, type ScannedModel } from '../lib/library';
import type { ModalTarget } from '../components/ModelModal';
import { SocketPill, TypeBadge } from '../components/ui';
import { FilterPills, PageHeader, SearchInput } from '../components/chrome';

type Filter = 'all' | ModelKind;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'checkpoint', label: 'Checkpoint' },
  { id: 'sdxl', label: 'SDXL' },
  { id: 'lora', label: 'LoRA' },
  { id: 'flux', label: 'Flux' },
];

const badgeType = (kind: ModelKind): string =>
  kind === 'checkpoint' ? 'Checkpoint' : kind === 'lora' ? 'LORA' : kind === 'sdxl' ? 'SDXL' : 'Flux';

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export default function Library({ onOpen }: { onOpen: (t: ModalTarget) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [scanned] = useState<ScannedModel[]>(loadScanned);

  const q = query.trim().toLowerCase();
  const matches = (hay: string) => !q || hay.toLowerCase().includes(q);

  const results = useMemo(() => {
    return MODELS.filter((m) => {
      if (filter !== 'all' && m.kind !== filter) return false;
      return matches(m.title) || matches(m.hash) || matches(m.path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filter]);

  const scannedShown = scanned.filter(
    (s) => matches(s.name) || matches(s.hash) || matches(s.filename),
  );

  return (
    <div>
      <PageHeader
        title="Local Model Library"
        subtitle="Downloaded weights with metadata, preview state, and socket health."
        meta={`${scannedShown.length + results.length} assets · ${scannedShown.length} scanned from disk`}
      />

      <div className="glass-l1 edge-shimmer mt-4 flex flex-wrap items-center gap-2 rounded-lg p-3">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search local models, hashes, paths…  ( / )"
        />
        <FilterPills options={FILTERS} active={filter} onPick={setFilter} />
      </div>

      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {scannedShown.map((s) => (
          <article
            key={`${s.modelId}-${s.versionId}`}
            className="glass-l1 rounded-lg p-3 ring-1 ring-inset ring-status-active/20 transition-colors hover:border-primary/40"
          >
            <button
              type="button"
              onClick={() =>
                onOpen({
                  kind: 'local',
                  title: s.name,
                  type: s.type,
                  hash: s.hash,
                  size: formatBytes(s.size),
                  path: `${s.dirPath}/${s.filename}`,
                  modelId: s.modelId || undefined,
                  versionId: s.versionId || undefined,
                })
              }
              className="block w-full text-left"
              title="Open details"
            >
              <div className="flex items-start justify-between gap-2">
                <TypeBadge type={s.type} />
                <SocketPill socket="rw" />
              </div>
              <h2 className="mt-2 font-display text-base font-semibold">{s.name}</h2>
            </button>
            <dl className="mt-2 space-y-1 font-mono text-[11px] text-ink-muted">
              <div className="flex justify-between gap-2">
                <dt>hash</dt>
                <dd>{s.hash}…</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>size</dt>
                <dd>{formatBytes(s.size)}</dd>
              </div>
              <div className="truncate pt-1 text-ink-faint">
                {s.dirPath}/{s.filename}
              </div>
              <div className="truncate text-status-active">
                ✓ metadata{s.imageName ? ' + preview' : ''} on disk
              </div>
            </dl>
          </article>
        ))}
        {results.map((m) => (
          <article
            key={m.id}
            className="glass-l1 rounded-lg p-3 transition-colors hover:border-primary/40"
          >
            <button
              type="button"
              onClick={() =>
                onOpen({
                  kind: 'local',
                  title: m.title,
                  type: badgeType(m.kind),
                  hash: m.hash,
                  size: m.size,
                  path: m.path,
                  params: m.params,
                })
              }
              className="block w-full text-left"
              title="Open details"
            >
              <div className="flex items-start justify-between gap-2">
                <TypeBadge type={badgeType(m.kind)} />
                <SocketPill socket={m.socket} />
              </div>
              <h2 className="mt-2 font-display text-base font-semibold">{m.title}</h2>
            </button>
            <dl className="mt-2 space-y-1 font-mono text-[11px] text-ink-muted">
              <div className="flex justify-between gap-2">
                <dt>params</dt>
                <dd className="text-ink">{m.params}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>hash</dt>
                <dd>{m.hash}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>size</dt>
                <dd>{m.size}</dd>
              </div>
              <div className="truncate pt-1 text-ink-faint">{m.path}</div>
            </dl>
          </article>
        ))}
      </section>

      {results.length === 0 && (
        <p className="mt-8 text-center font-mono text-xs text-ink-faint">
          No models match — clear search or filter.
        </p>
      )}
    </div>
  );
}
