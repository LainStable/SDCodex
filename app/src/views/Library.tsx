import { useEffect, useMemo, useState } from 'react';
import { BASE_MODELS } from '../lib/civitai';
import { MODEL_TYPES, getDirectories, getDirColors } from '../lib/settings';
import { folderForModelType } from '../lib/categories';
import { loadScanned, type ScannedModel } from '../lib/library';
import type { ModalTarget } from '../components/ModelModal';
import { SocketPill, TypeBadge } from '../components/ui';
import { BaseCloud, FilterPills, PageHeader, SearchInput } from '../components/chrome';

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
  files?: { image?: string; model?: string; metadata?: string };
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

const fileUrl = (absPath: string) => `/api/files?path=${encodeURIComponent(absPath)}`;

export default function Library({ onOpen }: { onOpen: (t: ModalTarget) => void }) {
  const [query, setQuery] = useState('');
  const [bases, setBases] = useState<string[]>([]);
  const [scanned] = useState<ScannedModel[]>(loadScanned);
  const [serverRows, setServerRows] = useState<ServerRow[]>([]);
  const [colors] = useState<Record<string, string>>(getDirColors);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  // Object URLs for browser-scanned previews (resolved via bound handles).
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});

  // Sections follow Settings: only configured categories appear.
  const sections: string[] = useMemo(() => {
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
    // Resolve browser-scanned preview images through their bound folders.
    void (async () => {
      if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') {
        return;
      }
      const { getHandle } = await import('../lib/idb');
      const found: Record<string, string> = {};
      for (const s of loadScanned()) {
        if (!s.imageName) continue;
        const key = `${s.dirKey}/${s.filename}`;
        try {
          const dir = await getHandle(s.dirKey);
          if (!dir) continue;
          const fh = await dir.getFileHandle(s.imageName);
          const file = await fh.getFile();
          if (!file.type.startsWith('image/')) continue;
          found[key] = URL.createObjectURL(file);
        } catch {
          /* unlinked or missing — card keeps its placeholder */
        }
      }
      if (live && Object.keys(found).length > 0) setLocalPreviews(found);
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
        folderForModelType(s.type) === t &&
        baseOk(s.baseModel ?? '') &&
        (matches(s.name) || matches(s.hash) || matches(s.filename)),
    );
  const serverByType = (t: string) =>
    serverRows.filter((r) => folderForModelType(r.type) === t && matches(r.name));

  const total = sections.reduce((n, t) => n + localByType(t).length + serverByType(t).length, 0);
  const active = activeTab && sections.includes(activeTab) ? activeTab : (sections[0] ?? null);

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

      {sections.length > 0 && (
        <div className="glass-l1 mt-4 rounded-lg p-3">
          <FilterPills
            options={sections.map((t) => {
              const n = localByType(t).length + serverByType(t).length;
              return { id: t, label: `${t} · ${n}` };
            })}
            active={active ?? ''}
            onPick={setActiveTab}
            activeColor={active ? colors[active] : undefined}
          />
        </div>
      )}

      {active &&
        (() => {
          const local = localByType(active);
          const remote = serverByType(active);
          return (
            <section key={active} className="mt-4">
              <div className="flex items-center gap-2">
                <TypeBadge type={active} color={colors[active]} />
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
                    className="glass-l1 overflow-hidden rounded-lg transition-colors hover:border-primary/40"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onOpen({ kind: 'civitai', modelId: r.modelId })
                      }
                      className="block w-full text-left"
                      title="Open details"
                    >
                      <div className="relative aspect-[4/3] bg-obsidian-lowest">
                        {r.files?.image ? (
                          <img
                            src={fileUrl(r.files.image)}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-faint">
                            no preview
                          </div>
                        )}
                        <div className="absolute left-2 top-2">
                          <TypeBadge type={r.type} color={colors[r.type]} />
                        </div>
                      </div>
                      <div className="p-3">
                        <h2 className="truncate font-display text-base font-semibold" title={r.name}>
                          {r.name}
                        </h2>
                        <div className="mt-1 flex items-center justify-between">
                          <SocketPill socket="rw" />
                          <span className="font-mono text-[10px] text-status-active">✓ on server</span>
                        </div>
                      </div>
                    </button>
                  </article>
                ))}
                {local.map((s) => (
                  <article
                    key={`${s.modelId}-${s.versionId}`}
                    className="glass-l1 overflow-hidden rounded-lg ring-1 ring-inset ring-status-active/20 transition-colors hover:border-primary/40"
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
                      <div className="relative aspect-[4/3] bg-obsidian-lowest">
                        {localPreviews[`${s.dirKey}/${s.filename}`] ? (
                          <img
                            src={localPreviews[`${s.dirKey}/${s.filename}`]}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center font-mono text-[11px] text-ink-faint">
                            no preview
                          </div>
                        )}
                        <div className="absolute left-2 top-2">
                          <TypeBadge type={s.type} color={colors[s.type]} />
                        </div>
                      </div>
                      <div className="p-3">
                        <h2 className="truncate font-display text-base font-semibold" title={s.name}>
                          {s.name}
                        </h2>
                        <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-ink-muted">
                          <SocketPill socket="rw" />
                          <span>{formatBytes(s.size)}</span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                          {s.dirPath}/{s.filename}
                        </div>
                        <div className="truncate font-mono text-[10px] text-status-active">
                          ✓ metadata{s.imageName ? ' + preview' : ''} on disk
                        </div>
                      </div>
                    </button>
                  </article>
                ))}
                </div>
              )}
            </section>
          );
        })()}
    </div>
  );
}
