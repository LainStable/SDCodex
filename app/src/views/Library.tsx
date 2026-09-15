import { useMemo, useState } from 'react';
import { MODELS, type ModelKind } from '../data/models';
import { fetchVersionByHash } from '../lib/civitai';
import { SocketPill, TypeBadge } from '../components/ui';
import { FilterPills, GhostButton, PageHeader, SearchInput } from '../components/chrome';

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

const MODEL_EXTS = ['.safetensors', '.ckpt', '.pt', '.bin'];

interface DiskEntry {
  name: string;
  size: number;
  handle: FileSystemFileHandle;
  state: 'found' | 'hashing' | 'identified' | 'unknown' | 'failed';
  match?: string;
}

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function Scanner() {
  const supported = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  const [dirName, setDirName] = useState<string | null>(null);
  const [entries, setEntries] = useState<DiskEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const pick = async () => {
    setNote(null);
    try {
      const picker = (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      const dir = await picker;
      setScanning(true);
      const found: DiskEntry[] = [];
      const entries = (
        dir as unknown as {
          values: () => AsyncIterable<[string, { kind: string; getFile: () => Promise<File> }]>;
        }
      ).values();
      for await (const [name, handle] of entries) {
        if (handle.kind !== 'file') continue;
        const lower = name.toLowerCase();
        if (!MODEL_EXTS.some((e) => lower.endsWith(e))) continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        found.push({ name, size: file.size, handle: handle as FileSystemFileHandle, state: 'found' });
      }
      setDirName(dir.name);
      setEntries(found);
      if (found.length === 0) setNote('No model files (.safetensors/.ckpt/.pt/.bin) in this directory.');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setNote(e instanceof Error ? e.message : 'Directory pick failed');
      }
    } finally {
      setScanning(false);
    }
  };

  const identify = async (index: number) => {
    const entry = entries[index];
    setEntries((es) => es.map((e, i) => (i === index ? { ...e, state: 'hashing' as const } : e)));
    try {
      const file = await entry.handle.getFile();
      const hash = await sha256Hex(file);
      const version = await fetchVersionByHash(hash);
      const match = `${version.model?.name ?? 'Unknown'} · ${version.name}`;
      setEntries((es) => es.map((e, i) => (i === index ? { ...e, state: 'identified' as const, match } : e)));
    } catch {
      setEntries((es) =>
        es.map((e, i) =>
          i === index
            ? { ...e, state: 'unknown' as const, match: 'No Civitai match for this hash' }
            : e,
        ),
      );
    }
  };

  if (!supported) {
    return (
      <p className="glass-l1 mt-3 rounded-lg p-3 font-mono text-[11px] text-ink-faint">
        Directory scan needs a Chromium browser (File System Access API). Library mocks below
        still work everywhere.
      </p>
    );
  }

  return (
    <div className="glass-l1 mt-3 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <GhostButton onClick={pick} disabled={scanning}>
          {scanning ? 'Scanning…' : dirName ? `Rescan ${dirName}` : 'Scan directory…'}
        </GhostButton>
        {dirName && (
          <span className="font-mono text-[11px] text-ink-faint">
            {dirName} · {entries.length} model file{entries.length === 1 ? '' : 's'}
          </span>
        )}
        {note && <span className="font-mono text-[11px] text-status-warning">{note}</span>}
      </div>
      {entries.length > 0 && (
        <ul className="mt-2 space-y-1">
          {entries.map((e, i) => (
            <li
              key={e.name}
              className="flex items-center gap-3 rounded border border-white/[0.06] px-2 py-1.5 font-mono text-[11px]"
            >
              <span className="min-w-0 flex-1 truncate text-ink">{e.name}</span>
              <span className="text-ink-muted">{formatBytes(e.size)}</span>
              {e.state === 'identified' || e.state === 'unknown' ? (
                <span className={e.state === 'identified' ? 'text-status-active' : 'text-ink-faint'}>
                  {e.match}
                </span>
              ) : (
                <GhostButton disabled={e.state === 'hashing'} onClick={() => identify(i)}>
                  {e.state === 'hashing' ? 'Hashing…' : 'Identify'}
                </GhostButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Library() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MODELS.filter((m) => {
      if (filter !== 'all' && m.kind !== filter) return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.hash.toLowerCase().includes(q) ||
        m.path.toLowerCase().includes(q)
      );
    });
  }, [query, filter]);

  return (
    <div>
      <PageHeader
        title="Local Model Library"
        subtitle="Downloaded weights with metadata, preview state, and socket health."
        meta={`${results.length}/${MODELS.length} assets · 742 GB of 2 TB`}
      />

      <div className="glass-l1 edge-shimmer mt-4 flex flex-wrap items-center gap-2 rounded-lg p-3">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search local models, hashes, paths…  ( / )"
        />
        <FilterPills options={FILTERS} active={filter} onPick={setFilter} />
      </div>

      <Scanner />

      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {results.map((m) => (
          <article
            key={m.id}
            className="glass-l1 rounded-lg p-3 transition-colors hover:border-primary/40"
          >
            <div className="flex items-start justify-between gap-2">
              <TypeBadge type={badgeType(m.kind)} />
              <SocketPill socket={m.socket} />
            </div>
            <h2 className="mt-2 font-display text-base font-semibold">{m.title}</h2>
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
