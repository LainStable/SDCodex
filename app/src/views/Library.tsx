import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { BASE_MODELS } from '../lib/civitai';
import { MODEL_TYPES, getDirectories, getDirColors } from '../lib/settings';
import { folderForModelType } from '../lib/categories';
import { loadScanned, type ScannedModel } from '../lib/library';
import type { ModalTarget } from '../components/ModelModal';
import { BaseModelBadge, TypeBadge } from '../components/ui';
import { BaseCloud, FilterPills, GhostButton, PageHeader, SearchInput } from '../components/chrome';

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

interface ServerRow {
  id: number;
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  baseModel?: string;
  files?: { image?: string; model?: string; metadata?: string };
}

async function fetchServerRows(): Promise<ServerRow[] | null> {
  const { apiGet, backendAvailable } = await import('../lib/backend');
  if (!(await backendAvailable())) return null;
  try {
    const r = await apiGet<{ items: ServerRow[] }>('/library');
    return r.items ?? [];
  } catch {
    // Null means "could not load" — keep retrying instead of showing an
    // empty library that looks like the scan found nothing.
    return null;
  }
}

const fileUrl = (absPath: string) => `/api/files?path=${encodeURIComponent(absPath)}`;

/* Replacing a cover image (or a scan finishing) remounts this view through
   `key`. Keep the grid where the user left it instead of jumping to the top. */
let savedScrollY = 0;

export default function Library({ onOpen }: { onOpen: (t: ModalTarget) => void }) {
  const [query, setQuery] = useState('');
  const [bases, setBases] = useState<string[]>([]);
  const [scanned, setScanned] = useState<ScannedModel[]>(loadScanned);
  const [serverRows, setServerRows] = useState<ServerRow[]>([]);
  const [serverState, setServerState] = useState<'loading' | 'ready' | 'error'>('loading');
  // Newer Civitai versions for identified local models, keyed modelId-versionId.
  const [updates, setUpdates] = useState<Record<string, { id: number; name?: string }>>({});
  const [colors] = useState<Record<string, string>>(getDirColors);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  // Grid is rendered in pages: a category can hold thousands of LoRAs.
  const [visible, setVisible] = useState(240);
  // Civitai answers for rows stored before the architecture was recorded,
  // keyed `modelId-versionId` (works without any folder permission).
  const [remoteBases, setRemoteBases] = useState<Record<string, string>>({});
  // Object URLs for browser-scanned previews (resolved via bound handles).
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});

  // Remember/replay the grid scroll position across remounts.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        savedScrollY = window.scrollY;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useLayoutEffect(() => {
    const target = savedScrollY;
    if (target <= 0) return;
    let active = true;
    const stop = () => {
      active = false;
    };
    // Server rows arrive after mount, so replay the position a few times
    // until the grid is tall enough to hold it.
    const apply = () => {
      if (active && Math.abs(window.scrollY - target) > 2) window.scrollTo(0, target);
    };
    apply();
    const timers = [80, 250, 600].map((ms) => window.setTimeout(apply, ms));
    window.addEventListener('wheel', stop, { passive: true, once: true });
    window.addEventListener('pointerdown', stop, { passive: true, once: true });
    window.addEventListener('touchstart', stop, { passive: true, once: true });
    window.addEventListener('keydown', stop, { once: true });
    return () => {
      active = false;
      timers.forEach(clearTimeout);
      window.removeEventListener('wheel', stop);
      window.removeEventListener('pointerdown', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
  }, []);

  // Sections follow Settings: only configured categories appear. If this
  // browser has no dir keys (fresh origin, cleared storage) fall back to the
  // categories the library actually contains so rows are never invisible.
  const sections: string[] = useMemo(() => {
    const dirs = getDirectories();
    const configured = new Set<string>();
    for (const key of Object.keys(dirs)) {
      if (!key.startsWith('dir_') || !(dirs[key] ?? '').trim()) continue;
      const rest = key.slice(4);
      const type = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
      if ((MODEL_TYPES as readonly string[]).includes(type)) configured.add(type);
    }
    if (configured.size > 0) return MODEL_TYPES.filter((t) => configured.has(t));
    const present = new Set<string>();
    for (const row of serverRows) {
      const type = folderForModelType(row.type);
      if (type) present.add(type);
    }
    for (const record of scanned) {
      const type = folderForModelType(record.type);
      if (type) present.add(type);
    }
    return MODEL_TYPES.filter((t) => present.has(t));
  }, [serverRows, scanned]);

  useEffect(() => {
    let live = true;
    let timer: number | null = null;
    let attempt = 0;
    let loading = false;
    const loadRows = async () => {
      if (loading) return;
      loading = true;
      const rows = await fetchServerRows();
      loading = false;
      if (!live) return;
      if (rows) {
        setServerRows(rows);
        setServerState('ready');
        attempt = 0;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        return;
      }
      setServerState('error');
      attempt += 1;
      if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          void loadRows();
        }, Math.min(10_000, 1500 * attempt));
      }
    };
    void loadRows();
    const onFocus = () => void loadRows();
    window.addEventListener('focus', onFocus);
    // Resolve browser-scanned preview images through their bound folders, and
    // backfill the architecture for records scanned before it was inferred.
    void (async () => {
      const canReadFolders =
        typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
      const { getHandle } = await import('../lib/idb');
      const { resolveRecordBaseModel } = await import('../lib/scan');
      const { setScannedBaseModelByFile } = await import('../lib/library');
      const found: Record<string, string> = {};
      let patched = false;
      for (const s of loadScanned()) {
        if (canReadFolders && s.imageName) {
          const key = `${s.dirKey}/${s.filename}`;
          try {
            const dir = await getHandle(s.dirKey);
            if (!dir) throw new Error('unbound');
            const parts = s.filename.split('/').filter(Boolean);
            let cur = dir;
            for (const part of parts.slice(0, -1)) cur = await cur.getDirectoryHandle(part);
            const fh = await cur.getFileHandle(s.imageName);
            const file = await fh.getFile();
            if (file.type.startsWith('image/')) found[key] = URL.createObjectURL(file);
          } catch {
            /* unlinked or missing — card keeps its placeholder */
          }
        }
        if (s.baseModel) continue;
        // Sidecar metadata first, then the weights header; the folder search
        // also repairs records saved before per-path keys existed.
        const hit = await resolveRecordBaseModel(s);
        if (hit && setScannedBaseModelByFile(s.dirKey, s.filename, hit.baseModel, hit)) patched = true;
      }
      if (!live) return;
      if (Object.keys(found).length > 0) setLocalPreviews(found);
      if (patched) setScanned(loadScanned());
    })();
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Ask the backend which installed models have a newer Civitai version. The
  // backend answers immediately from cache and refreshes the rest in the
  // background, so poll while it reports `pending`.
  useEffect(() => {
    const items = [
      ...scanned.map((s) => ({ modelId: s.modelId, versionId: s.versionId })),
      ...serverRows.map((r) => ({ modelId: r.modelId, versionId: r.versionId })),
    ].filter((s) => s.modelId > 0 && s.versionId > 0);
    if (items.length === 0) return;
    let live = true;
    let timer: number | null = null;
    const load = async (attempt: number) => {
      try {
        const { apiPost, backendAvailable } = await import('../lib/backend');
        if (!(await backendAvailable())) return;
        const r = await apiPost<{
          updates?: Record<string, { id: number; name?: string }>;
          pending?: boolean;
        }>('/library/updates', { items });
        if (!live) return;
        setUpdates(r.updates ?? {});
        if (r.pending && attempt < 5) {
          timer = window.setTimeout(() => void load(attempt + 1), 4000);
        }
      } catch {
        /* offline — no update badges */
      }
    };
    void load(0);
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [scanned, serverRows]);

  // Records stored before the architecture was captured: ask Civitai once per
  // model id. The version row carries `baseModel`, so this needs no folder
  // permission and covers .ckpt files the header reader cannot parse.
  useEffect(() => {
    const want = new Map<number, Set<number>>();
    const add = (modelId?: number, versionId?: number, base?: string) => {
      if (!modelId || !versionId || (base ?? '').trim()) return;
      const set = want.get(modelId) ?? new Set<number>();
      set.add(versionId);
      want.set(modelId, set);
    };
    scanned.forEach((s) => add(s.modelId, s.versionId, s.baseModel));
    serverRows.forEach((r) => add(r.modelId, r.versionId, r.baseModel));
    // Keep the burst small; the rest fills in on the next visit.
    const ids = [...want.keys()].slice(0, 8);
    if (ids.length === 0) return;
    let live = true;
    void (async () => {
      const { fetchModel } = await import('../lib/civitai');
      const found: Record<string, string> = {};
      for (const modelId of ids) {
        try {
          const model = await fetchModel(modelId);
          for (const v of model.modelVersions ?? []) {
            if (!want.get(modelId)?.has(v.id)) continue;
            if ((v.baseModel ?? '').trim()) found[`${modelId}-${v.id}`] = v.baseModel.trim();
          }
        } catch {
          /* offline or removed — chip keeps its fallback */
        }
      }
      if (live && Object.keys(found).length > 0) {
        setRemoteBases((current) => ({ ...found, ...current }));
        // Persist for scan records so a reload does not need the API again.
        const { setScannedBaseModelByFile } = await import('../lib/library');
        let patched = false;
        for (const s of loadScanned()) {
          const hit = found[`${s.modelId}-${s.versionId}`];
          if (!hit || s.baseModel) continue;
          if (setScannedBaseModelByFile(s.dirKey, s.filename, hit)) patched = true;
        }
        if (patched) setScanned(loadScanned());
      }
    })();
    return () => {
      live = false;
    };
  }, [scanned, serverRows]);

  const updateFor = (modelId?: number, versionId?: number) =>
    modelId && versionId ? updates[`${modelId}-${versionId}`] : undefined;

  /** Architecture fetched from Civitai for rows stored without one. */
  const remoteBase = (modelId?: number, versionId?: number) =>
    modelId && versionId ? remoteBases[`${modelId}-${versionId}`] : undefined;

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

  useEffect(() => {
    setVisible(240);
  }, [active, query, bases]);

  return (
    <div>
      <PageHeader
        title="Local Model Library"
        subtitle="Scanned weights grouped by your configured categories."
        meta={
          serverState === 'error'
            ? 'backend slow — retrying…'
            : serverState === 'loading' && serverRows.length === 0
              ? 'loading library…'
              : `${total} assets · ${sections.length} categor${sections.length === 1 ? 'y' : 'ies'}`
        }
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
            options={sections.map((t) => ({
              id: t,
              label: `${t} · ${localByType(t).length + serverByType(t).length}`,
              color: colors[t],
            }))}
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
                  {serverState === 'error'
                    ? 'Waiting for the backend — retrying…'
                    : serverState === 'loading' && serverRows.length === 0
                      ? 'Loading library…'
                      : 'Empty — run Scan in Settings → Model dirs.'}
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {remote.slice(0, visible).map((r) => {
                  const up = updateFor(r.modelId, r.versionId);
                  return (
                  <article
                    key={`srv-${r.modelId}-${r.versionId}`}
                    className="glass-l1 overflow-hidden rounded-lg transition-colors hover:border-primary/40"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onOpen({
                          kind: 'local',
                          title: r.name,
                          type: r.type,
                          modelId: r.modelId || undefined,
                          versionId: r.versionId || undefined,
                          rowId: r.id,
                        })
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
                          <img
                              src="/model-placeholder.svg"
                              alt="Unidentified model"
                              loading="lazy"
                              className="h-full w-full object-cover opacity-80"
                            />
                        )}
                        <div className="absolute left-2 top-2">
                          <TypeBadge type={r.type} color={colors[r.type]} />
                        </div>
                        {up && (
                          <span
                            className="absolute right-2 top-2 rounded border border-status-warning/50 bg-status-warning/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-[#fcd34d]"
                            title={`Civitai has v${up.name || up.id} available`}
                          >
                            update → v{up.name || up.id}
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        <h2 className="truncate font-display text-base font-semibold" title={r.name}>
                          {r.name}
                        </h2>
                        <div className="mt-1.5">
                          <BaseModelBadge
                            baseModel={r.baseModel || remoteBase(r.modelId, r.versionId)}
                          />
                        </div>
                      </div>
                    </button>
                  </article>
                  );
                })}
                {local.slice(0, visible).map((s) => {
                  const up = updateFor(s.modelId, s.versionId);
                  return (
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
                          record:
                            s.modelId && s.versionId
                              ? { modelId: s.modelId, versionId: s.versionId }
                              : undefined,
                          dirKey: s.dirKey,
                          imageName: s.imageName ?? undefined,
                          relativePath: s.filename,
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
                          <img
                              src="/model-placeholder.svg"
                              alt="Unidentified model"
                              loading="lazy"
                              className="h-full w-full object-cover opacity-80"
                            />
                        )}
                        <div className="absolute left-2 top-2">
                          <TypeBadge type={s.type} color={colors[s.type]} />
                        </div>
                        {up && (
                          <span
                            className="absolute right-2 top-2 rounded border border-status-warning/50 bg-status-warning/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-[#fcd34d]"
                            title={`Civitai has v${up.name || up.id} available`}
                          >
                            update → v{up.name || up.id}
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        <h2 className="truncate font-display text-base font-semibold" title={s.name}>
                          {s.name}
                        </h2>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <BaseModelBadge
                            baseModel={s.baseModel || remoteBase(s.modelId, s.versionId)}
                          />
                          <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                            {formatBytes(s.size)}
                          </span>
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
                  );
                })}
                </div>
              )}
              {(remote.length > visible || local.length > visible) && (
                <div className="mt-3 flex justify-center">
                  <GhostButton onClick={() => setVisible((n) => n + 240)}>
                    Show more ({Math.max(remote.length, local.length) - visible} remaining)
                  </GhostButton>
                </div>
              )}
            </section>
          );
        })()}
    </div>
  );
}
