import { useEffect, useMemo, useState } from 'react';
import { BASE_MODELS } from '../lib/civitai';
import { MODEL_TYPES, getDirectories } from '../lib/settings';
import { loadScanned, type ScannedModel } from '../lib/library';
import type { ModalTarget } from '../components/ModelModal';
import { SocketPill, TypeBadge } from '../components/ui';
import { BaseCloud, PageHeader, SearchInput } from '../components/chrome';

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

interface ServerRow {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
}

async function fetchServerRows(): Promise<ServerRow[]> {
  const { apiGet, backendAvailable } = await import('../lib/backend');
  if (!(await backendAvailable())) return [];
  try {
    const r = await apiGet<{ items: ServerRow[] }>('/library');
    return r.items ?? [];
  } catch {
    return [];
  }
}

export default function Library({ onOpen }: { onOpen: (t: ModalTarget) => void }) {
  const [query, setQuery] = useState('');
  const [bases, setBases] = useState<string[]>([]);
  const [scanned] = useState<ScannedModel[]>(loadScanned);
  const [serverRows, setServerRows] = useState<ServerRow[]>([]);

  // Sections follow Settings: only configured categories appear.
  const sections = useMemo(() => {
    const dirs = getDirectories();
    const configured = new Set<string>();
    for (const key of Object.keys(dirs)) {
      if (!key.startsWith('dir_') || !(dirs[key] ?? '').trim()) continue;
      const rest = key.slice(4);
      const type = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
      if ((MODEL_TYPES as readonly string[]).includes(type)) configured.add(type);
    }
    return MODEL_TYPES.filter((t) => configured.has(t));
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const rows = await fetchServerRows();
      if (live) setServerRows(rows);
    })();
    return () => {
      live = false;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const matches = (hay: string) => !q || hay.toLowerCase().includes(q);
  const baseOk = (b: string) => bases.length === 0 || bases.includes(b);

  const localByType = (t: string) =>
    scanned.filter(
      (s) =>
        s.type === t &&
        baseOk(s.baseModel ?? '') &&
        (matches(s.name) || matches(s.hash) || matches(s.filename)),
    );
  const serverByType = (t: string) =>
    serverRows.filter((r) => r.type === t && matches(r.name));

  const total = sections.reduce((n, t) => n + localByType(t).length + serverByType(t).length, 0);

  return (
    <div>
      <PageHeader
        title="Local Model Library"
        subtitle="Scanned weights grouped by your configured categories."
        meta={`${total} assets · ${sections.length} categor${sections.length === 1 ? 'y' : 'ies'}`}
      />

      <div className="glass-l1 edge-shimmer mt-4 rounded-lg p-3">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search local models, hashes, paths…  ( / )"
        />
        <div className="mt-3 border-t border-white/[0.06] pt-3">
          <BaseCloud
            options={BASE_MODELS}
            active={bases}
            onToggle={(b) =>
              setBases((cur) => (cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]))
            }
            onClear={() => setBases([])}
          />
        </div>
      </div>

      {sections.length === 0 && (
        <p className="glass-l1 mt-4 rounded-lg p-6 text-center font-mono text-xs text-ink-faint">
          No categories configured — add model folders in Settings → Model dirs.
        </p>
      )}

      {sections.map((t) => {
        const local = localByType(t);
        const remote = serverByType(t);
        return (
          <section key={t} className="mt-5">
            <div className="flex items-center gap-2">
              <TypeBadge type={t} />
              <span className="font-mono text-[11px] text-ink-faint">
                {local.length + remote.length} model{local.length + remote.length === 1 ? '' : 's'}
              </span>
            </div>
            {local.length + remote.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-ink-faint">
                Empty — run Scan in Settings → Model dirs.
              </p>
            ) : (
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {remote.map((r) => (
                  <article
                    key={`srv-${r.modelId}-${r.versionId}`}
                    className="glass-l1 rounded-lg p-3 transition-colors hover:border-primary/40"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onOpen({ kind: 'civitai', modelId: r.modelId })
                      }
                      className="block w-full text-left"
                      title="Open details"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <TypeBadge type={r.type} />
                        <SocketPill socket="rw" />
                      </div>
                      <h2 className="mt-2 font-display text-base font-semibold">{r.name}</h2>
                    </button>
                    <dl className="mt-2 space-y-1 font-mono text-[11px] text-ink-muted">
                      <div className="truncate text-status-active">✓ on server</div>
                    </dl>
                  </article>
                ))}
                {local.map((s) => (
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
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
