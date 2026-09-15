import { useEffect, useMemo, useState } from 'react';
import { MODELS, type ModelKind } from '../data/models';
import { fetchModel, fetchVersionByHash } from '../lib/civitai';
import { MODEL_TYPES, getDirectories } from '../lib/settings';
import { ensurePermission, forgetHandle, getHandle, putHandle } from '../lib/idb';
import { loadScanned, pruneScanned, upsertScanned, type ScannedModel } from '../lib/library';
import { SocketPill, TypeBadge } from '../components/ui';
import { FilterPills, GhostButton, PageHeader, PrimaryButton, SearchInput } from '../components/chrome';

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

/** Same model extensions OldCode scanner.py accepts. */
const MODEL_EXTS = ['.safetensors', '.ckpt', '.pt', '.bin'];

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type ValuesFn = () => AsyncIterable<[string, { kind: string; getFile: () => Promise<File> }]>;

function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
  return w.showDirectoryPicker();
}

async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

async function writeBytesFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

interface DirState {
  type: string;
  path: string;
  bound: boolean;
  message: string;
}

/**
 * Library scanner. Mirrors OldCode scanner.scan_directory per configured
 * Settings dir (dir_<type>): enumerate model files → SHA-256 → Civitai by-hash
 * lookup → write <base>.metadata.json + preview image → record. Browser folder
 * picks are bound to the Settings path and persisted in IndexedDB, so later
 * scans run without prompting.
 */
function Scanner({ onChanged }: { onChanged: (list: ScannedModel[]) => void }) {
  const supported =
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  const configured = useMemo(() => {
    const dirs = getDirectories();
    return MODEL_TYPES.map((t) => ({ type: t, path: dirs[`dir_${t}`] ?? '' })).filter(
      (d) => d.path.trim() !== '',
    );
  }, []);
  const [rows, setRows] = useState<DirState[]>(() =>
    configured.map((c) => ({ type: c.type, path: c.path, bound: false, message: 'not linked' })),
  );
  const [scanning, setScanning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    (async () => {
      const states = await Promise.all(
        configured.map(async (c) => {
          const h = await getHandle(`dir_${c.type}`);
          return h !== null;
        }),
      );
      if (!live) return;
      setRows((rs) => rs.map((r, i) => ({ ...r, bound: states[i], message: states[i] ? 'linked' : 'not linked' })));
    })();
    return () => {
      live = false;
    };
  }, [configured]);

  const say = (line: string) => setLog((l) => [...l.slice(-8), line]);
  const setRow = (type: string, patch: Partial<DirState>) =>
    setRows((rs) => rs.map((r) => (r.type === type ? { ...r, ...patch } : r)));

  const bind = async (type: string): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const dir = await pickDirectory();
      const ok = await ensurePermission(dir, 'readwrite');
      if (!ok) {
        setRow(type, { message: 'permission denied' });
        return null;
      }
      await putHandle(`dir_${type}`, dir);
      setRow(type, { bound: true, message: 'linked' });
      return dir;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setRow(type, { message: 'pick failed' });
      return null;
    }
  };

  const forget = async (type: string) => {
    await forgetHandle(`dir_${type}`);
    setRow(type, { bound: false, message: 'not linked' });
  };

  /** Scan one Settings dir. Returns files seen (for missing-model cleanup). */
  const scanDir = async (type: string, path: string, seen: Set<string>): Promise<number> => {
    let dir = await getHandle(`dir_${type}`);
    if (!dir) {
      say(`${type}: pick the folder for ${path}`);
      dir = await bind(type);
      if (!dir) return 0;
    } else if (!(await ensurePermission(dir, 'readwrite'))) {
      setRow(type, { message: 'permission denied' });
      return 0;
    }

    const values = (dir as unknown as { values: ValuesFn }).values();
    const files: { name: string; handle: FileSystemFileHandle }[] = [];
    for await (const [name, handle] of values) {
      if (handle.kind !== 'file') continue;
      if (!MODEL_EXTS.some((e) => name.toLowerCase().endsWith(e))) continue;
      files.push({ name, handle: handle as FileSystemFileHandle });
    }

    let updated = 0;
    let done = 0;
    for (const f of files) {
      done += 1;
      setRow(type, { message: `Scanning ${f.name}... (${done}/${files.length})` });
      seen.add(`dir_${type}/${f.name}`);
      try {
        const file = await f.handle.getFile();
        const hash = await sha256Hex(file);
        const version = await fetchVersionByHash(hash);
        const versionId = version.id;
        const modelId = version.modelId ?? 0;
        const base = f.name.replace(/\.[^.]+$/, '');

        // Metadata: full model JSON, OldCode "<base>.metadata.json".
        const metaName = `${base}.metadata.json`;
        if (!(await fileExists(dir, metaName))) {
          try {
            const full = modelId ? await fetchModel(modelId) : null;
            await writeTextFile(dir, metaName, JSON.stringify(full ?? version, null, 4));
          } catch {
            /* metadata best-effort */
          }
        }

        // Preview image: extension follows the URL, OldCode convention.
        let imageName: string | null = null;
        const imgUrl = version.images?.[0]?.url;
        if (imgUrl) {
          const ext = imgUrl.includes('.png') ? '.png' : imgUrl.includes('.jpg') || imgUrl.includes('.jpeg') ? '.jpg' : '.webp';
          imageName = `${base}${ext}`;
          if (!(await fileExists(dir, imageName))) {
            try {
              const res = await fetch(imgUrl);
              if (res.ok) await writeBytesFile(dir, imageName, await res.arrayBuffer());
              else imageName = null;
            } catch {
              imageName = null;
            }
          }
        }

        upsertScanned({
          modelId,
          versionId,
          name: version.model?.name ?? f.name,
          type: version.model?.type ?? type,
          dirKey: `dir_${type}`,
          dirPath: path,
          filename: f.name,
          hash: hash.slice(0, 12),
          size: file.size,
          imageName,
          scannedAt: Date.now(),
        });
        updated += 1;
      } catch {
        say(`${type}: could not identify ${f.name}`);
      }
    }
    onChanged(loadScanned());
    setRow(type, { message: `done · ${updated}/${files.length} identified` });
    say(`${type}: scanned ${files.length} files, updated ${updated} models.`);
    return updated;
  };

  const scanAll = async () => {
    if (configured.length === 0) return;
    setScanning(true);
    setLog([]);
    const seen = new Set<string>();
    let total = 0;
    for (const c of configured) {
      total += await scanDir(c.type, c.path, seen);
    }
    // Cleanup records whose files vanished (OldCode missing-model cleanup).
    const { removed } = pruneScanned(seen);
    onChanged(loadScanned());
    say(removed > 0 ? `Removed ${removed} missing models.` : 'Scan complete.');
    setScanning(false);
  };

  if (!supported) {
    return (
      <p className="glass-l1 mt-3 rounded-lg p-3 font-mono text-[11px] text-ink-faint">
        Directory scan needs a Chromium browser (File System Access API). Library entries below
        still work everywhere.
      </p>
    );
  }

  if (configured.length === 0) {
    return (
      <p className="glass-l1 mt-3 rounded-lg p-3 font-mono text-[11px] text-ink-faint">
        No model directories configured — set them in Settings → Download dirs, then scan here.
      </p>
    );
  }

  return (
    <div className="glass-l1 mt-3 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <PrimaryButton disabled={scanning} onClick={() => void scanAll()}>
          {scanning ? 'Scanning…' : 'Scan library'}
        </PrimaryButton>
        <span className="font-mono text-[11px] text-ink-faint">
          {configured.length} configured director{configured.length === 1 ? 'y' : 'ies'} (Settings paths)
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li
            key={r.type}
            className="flex flex-wrap items-center gap-2 rounded border border-white/[0.06] px-2 py-1.5 font-mono text-[11px]"
          >
            <span className="w-28 shrink-0 text-ink">{r.type}</span>
            <span className="min-w-0 flex-1 truncate text-ink-faint">{r.path}</span>
            <span className={r.bound ? 'text-status-active' : 'text-status-warning'}>
              {r.bound ? 'linked' : 'pick folder'}
            </span>
            <span className="hidden w-full truncate text-ink-faint sm:block">{r.message}</span>
            <GhostButton disabled={scanning} onClick={() => void bind(r.type)}>
              {r.bound ? 'Re-link' : 'Link'}
            </GhostButton>
            {r.bound && (
              <GhostButton disabled={scanning} onClick={() => void forget(r.type)}>
                Forget
              </GhostButton>
            )}
            <GhostButton
              disabled={scanning}
              onClick={() => void (async () => {
                setScanning(true);
                const seen = new Set(loadScanned().map((e) => `${e.dirKey}/${e.filename}`));
                await scanDir(r.type, r.path, seen);
                setScanning(false);
              })()}
            >
              Scan
            </GhostButton>
          </li>
        ))}
      </ul>
      {log.length > 0 && (
        <div className="mt-2 rounded border border-white/[0.06] bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-ink-muted">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Library() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [scanned, setScanned] = useState<ScannedModel[]>(loadScanned);

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

      <Scanner onChanged={setScanned} />

      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {scannedShown.map((s) => (
          <article
            key={`${s.modelId}-${s.versionId}`}
            className="glass-l1 rounded-lg p-3 ring-1 ring-inset ring-status-active/20 transition-colors hover:border-primary/40"
          >
            <div className="flex items-start justify-between gap-2">
              <TypeBadge type={s.type} />
              <SocketPill socket="rw" />
            </div>
            <h2 className="mt-2 font-display text-base font-semibold">{s.name}</h2>
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
