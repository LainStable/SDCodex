/* Scan engine. Mirrors OldCode scanner.scan_directory per configured Settings
   dir: enumerate model files → SHA-256 → Civitai by-hash → write
   <base>.metadata.json + preview image → record. */

import { fetchModel, fetchVersionByHash } from './civitai';
import { ensurePermission, getHandle, putHandle } from './idb';
import { upsertScanned } from './library';
import { getDirectories } from './settings';
import { apiGet, apiPost, backendAvailable } from './backend';

/** Server-side scan (no folder picker — the backend reads its own paths). */
export async function serverScan(types?: string[]): Promise<void> {
  if (!(await backendAvailable())) throw new Error('backend unreachable');
  await apiPost('/scan', types ? { types } : {});
}

export interface ServerScanStatus {
  current_task: { status?: string; message?: string; progress?: number } | null;
  queue_length: number;
}

export async function serverScanStatus(): Promise<ServerScanStatus> {
  return apiGet<ServerScanStatus>('/downloads/status');
}

/** Same model extensions OldCode scanner.py accepts. */
export const MODEL_EXTS = ['.safetensors', '.ckpt', '.pt', '.bin'];

export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type ValuesFn = () => AsyncIterable<[string, { kind: string; getFile: () => Promise<File> }]>;

export function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
  return w.showDirectoryPicker();
}

/** Stable stand-in id for unidentified files (unique per folder+name). */
export function pathId(rel: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < rel.length; i++) {
    crc ^= rel.charCodeAt(i);
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
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

export interface ScanHandle {
  dir: FileSystemDirectoryHandle;
  /** Resolve (and if needed pick) the bound folder for a type. */
  resolve: (type: string) => Promise<FileSystemDirectoryHandle | null>;
}

/** Scan one Settings type across every saved folder. Returns files identified;
    appends seen keys for cleanup. */
export async function scanDir(
  type: string,
  resolveAll: (type: string) => Promise<FileSystemDirectoryHandle[]>,
  seen: Set<string>,
  onMsg: (msg: string) => void,
): Promise<number> {
  const roots = await resolveAll(type);
  if (roots.length === 0) return 0;

  // Recursive: users sort models into subfolders. Sidecars stay next to
  // their model file; seen keys use paths relative to the linked folder.
  const files: { rel: string; handle: FileSystemFileHandle; dir: FileSystemDirectoryHandle }[] = [];
  const walkDir = async (
    d: FileSystemDirectoryHandle,
    prefix: string,
    out: { rel: string; handle: FileSystemFileHandle; dir: FileSystemDirectoryHandle }[],
  ) => {
    const it = (d as unknown as { values: ValuesFn }).values();
    for await (const [name, handle] of it) {
      if (handle.kind === 'directory') {
        await walkDir(handle as unknown as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
      } else if (handle.kind === 'file' && MODEL_EXTS.some((e) => name.toLowerCase().endsWith(e))) {
        out.push({ rel: `${prefix}${name}`, handle: handle as FileSystemFileHandle, dir: d });
      }
    }
  };
  for (const root of roots) {
    if (!(await ensurePermission(root, 'readwrite'))) {
      onMsg(`${type}: permission denied`);
      continue;
    }
    await walkDir(root, '', files);
  }

  let updated = 0;
  let done = 0;
  for (const f of files) {
    const name = f.rel.split('/').pop() ?? f.rel;
    done += 1;
    onMsg(`${type}: Scanning ${f.rel}... (${done}/${files.length})`);
    seen.add(`dir_${type}/${f.rel}`);
    try {
      const file = await f.handle.getFile();
      const hash = await sha256Hex(file);
      const version = await fetchVersionByHash(hash);
      const versionId = version.id;
      const modelId = version.modelId ?? 0;
      const base = name.replace(/\.[^.]+$/, '');

      const metaName = `${base}.metadata.json`;
      if (!(await fileExists(f.dir, metaName))) {
        try {
          const full = modelId ? await fetchModel(modelId) : null;
          const fh = await f.dir.getFileHandle(metaName, { create: true });
          const w = await fh.createWritable();
          await w.write(JSON.stringify(full ?? version, null, 4));
          await w.close();
        } catch {
          /* metadata best-effort */
        }
      }

      let imageName: string | null = null;
      const imgUrl = version.images?.[0]?.url;
      if (imgUrl) {
        const ext = imgUrl.includes('.png') ? '.png' : imgUrl.includes('.jpg') || imgUrl.includes('.jpeg') ? '.jpg' : '.webp';
        imageName = `${base}${ext}`;
        if (!(await fileExists(f.dir, imageName))) {
          try {
            const res = await fetch(imgUrl);
            if (res.ok) await writeBytesFile(f.dir, imageName, await res.arrayBuffer());
            else imageName = null;
          } catch {
            imageName = null;
          }
        }
      }

      upsertScanned({
        modelId,
        versionId,
        name: version.model?.name ?? name,
        // Folder category, not the API taxonomy — sections follow Settings.
        type,
        baseModel: version.baseModel ?? '',
        dirKey: `dir_${type}`,
        dirPath: getDirectories()[`dir_${type}`] ?? '',
        filename: f.rel,
        hash: hash.slice(0, 12),
        size: file.size,
        imageName,
        identified: true,
        scannedAt: Date.now(),
      });
      updated += 1;
    } catch {
      // Unidentified: still display the model. Prefer a sidecar image the
      // folder already has (<base>.png/.jpg/.webp); else the placeholder.
      // A stable stand-in id lets Update-metadata adopt a match later.
      let size = 0;
      try {
        size = (await f.handle.getFile()).size;
      } catch {
        /* unreadable — list by name only */
      }
      const base = (f.rel.split('/').pop() ?? f.rel).replace(/\.[^.]+$/, '');
      let sidecar: string | null = null;
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        if (await fileExists(f.dir, `${base}${ext}`)) {
          sidecar = `${base}${ext}`;
          break;
        }
      }
      upsertScanned({
        modelId: 0,
        versionId: pathId(`${type}/${f.rel}`),
        name: base,
        type,
        baseModel: '',
        dirKey: `dir_${type}`,
        dirPath: getDirectories()[`dir_${type}`] ?? '',
        filename: f.rel,
        hash: '',
        size,
        imageName: sidecar,
        identified: false,
        scannedAt: Date.now(),
      });
      onMsg(`${type}: no Civitai match for ${f.rel} — kept as unknown`);
    }
  }
  onMsg(`${type}: scanned ${files.length} files, updated ${updated} models.`);
  return updated;
}

export async function resolveBound(type: string): Promise<FileSystemDirectoryHandle | null> {
  return getHandle(`dir_${type}`);
}

export async function bindDirectory(type: string): Promise<FileSystemDirectoryHandle | null> {
  return bindDirectoryKey(`dir_${type}`);
}

export async function bindDirectoryKey(key: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const dir = await pickDirectory();
    if (!(await ensurePermission(dir, 'readwrite'))) return null;
    await putHandle(key, dir);
    return dir;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}
