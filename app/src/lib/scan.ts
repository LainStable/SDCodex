/* Scan engine. Mirrors OldCode scanner.scan_directory per configured Settings
   dir: enumerate model files → SHA-256 → Civitai by-hash → write
   <base>.metadata.json + preview image → record. */

import { fetchModel, fetchVersionByHash } from './civitai';
import { ensurePermission, getHandle, putHandle } from './idb';
import { upsertScanned } from './library';
import { getDirectories } from './settings';

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

/** Scan one Settings dir. Returns files identified; appends seen keys for cleanup. */
export async function scanDir(
  type: string,
  resolve: (type: string) => Promise<FileSystemDirectoryHandle | null>,
  seen: Set<string>,
  onMsg: (msg: string) => void,
): Promise<number> {
  const dir = await resolve(type);
  if (!dir) return 0;
  if (!(await ensurePermission(dir, 'readwrite'))) {
    onMsg(`${type}: permission denied`);
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
    onMsg(`${type}: Scanning ${f.name}... (${done}/${files.length})`);
    seen.add(`dir_${type}/${f.name}`);
    try {
      const file = await f.handle.getFile();
      const hash = await sha256Hex(file);
      const version = await fetchVersionByHash(hash);
      const versionId = version.id;
      const modelId = version.modelId ?? 0;
      const base = f.name.replace(/\.[^.]+$/, '');

      const metaName = `${base}.metadata.json`;
      if (!(await fileExists(dir, metaName))) {
        try {
          const full = modelId ? await fetchModel(modelId) : null;
          const fh = await dir.getFileHandle(metaName, { create: true });
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
        dirPath: getDirectories()[`dir_${type}`] ?? '',
        filename: f.name,
        hash: hash.slice(0, 12),
        size: file.size,
        imageName,
        scannedAt: Date.now(),
      });
      updated += 1;
    } catch {
      onMsg(`${type}: could not identify ${f.name}`);
    }
  }
  onMsg(`${type}: scanned ${files.length} files, updated ${updated} models.`);
  return updated;
}

export async function resolveBound(type: string): Promise<FileSystemDirectoryHandle | null> {
  return getHandle(`dir_${type}`);
}

export async function bindDirectory(type: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const dir = await pickDirectory();
    if (!(await ensurePermission(dir, 'readwrite'))) return null;
    await putHandle(`dir_${type}`, dir);
    return dir;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}
