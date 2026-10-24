/* Scan engine. Mirrors OldCode scanner.scan_directory per configured Settings
   dir: enumerate model files → SHA-256 → Civitai by-hash → write
   <base>.metadata.json + preview image → record. */

import { fetchVersionByHash } from './civitai';
import { ensurePermission, getHandle, putHandle } from './idb';
import { loadScanned, renameScannedFileRecord, upsertScanned } from './library';
import { isScanCancelled } from './scanstate';
import { getDirectories } from './settings';
import { apiGet, apiPost, backendAvailable } from './backend';

/** Server-side scan (no folder picker — the backend reads its own paths).
    `mode: 'identify'` hashes and matches rows saved as unidentified. */
export async function serverScan(types?: string[], mode?: 'scan' | 'identify'): Promise<void> {
  if (!(await backendAvailable())) throw new Error('backend unreachable');
  await apiPost('/scan', {
    ...(types ? { types } : {}),
    ...(mode && mode !== 'scan' ? { mode } : {}),
  });
}

/** Cancel the running/queued server scan or identify task. */
export async function serverScanCancel(): Promise<void> {
  if (!(await backendAvailable())) throw new Error('backend unreachable');
  await apiPost('/scan/cancel', {});
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

/** Map safetensors `__metadata__` keys (modelspec / A1111) to a Civitai base
    model label. Used when the hash has no Civitai match, so unidentified files
    still show their architecture instead of "unknown". */
export function baseModelFromMetadata(meta: Record<string, unknown>): string {
  const text = [
    'modelspec.architecture',
    'modelspec.base_model',
    'modelspec.title',
    'ss_base_model_version',
    'ss_sd_model_name',
  ]
    .map((key) => String(meta[key] ?? ''))
    .join(' ')
    .toLowerCase();
  if (!text.trim()) return '';
  if (/flux/.test(text)) return 'Flux.1 D';
  if (/pony/.test(text)) return 'Pony';
  if (/illustrious/.test(text)) return 'Illustrious';
  if (/noobai/.test(text)) return 'NoobAI';
  if (/sdxl|sd_xl|xl_base|stable-diffusion-xl/.test(text)) return 'SDXL 1.0';
  if (/sd_?3|stable-diffusion-3/.test(text)) return 'SD 3';
  if (/sd15|sd_v1|stable-diffusion-v1/.test(text)) return 'SD 1.5';
  if (/sd_?2|stable-diffusion-2/.test(text)) return 'SD 2.1';
  return '';
}

/** Read just the safetensors header (8-byte length + JSON) from a File. */
export async function inferBaseModel(file: File): Promise<string> {
  if (!file.name.toLowerCase().endsWith('.safetensors')) return '';
  try {
    const length = Number(new DataView(await file.slice(0, 8).arrayBuffer()).getBigUint64(0, true));
    if (!length || length > 4 * 1024 * 1024) return '';
    const header = JSON.parse(new TextDecoder().decode(await file.slice(8, 8 + length).arrayBuffer())) as {
      __metadata__?: Record<string, unknown>;
    };
    return baseModelFromMetadata(header.__metadata__ ?? {});
  } catch {
    return '';
  }
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

export interface ScanRoot {
  /** Settings key (`dir_LORA`, `dir_LORA__2`) — also the record's dirKey. */
  key: string;
  dir: FileSystemDirectoryHandle;
}

/** Every folder bound for a category, keyed like Settings stores them
    (`dir_<Type>`, `dir_<Type>__1`, …). Handles survive restarts; a folder that
    was never picked simply has no entry. */
export async function boundFolders(type: string): Promise<ScanRoot[]> {
  const keys = [
    `dir_${type}`,
    ...Object.keys(getDirectories())
      .filter((k) => k.startsWith(`dir_${type}__`))
      .sort(),
  ];
  const out: ScanRoot[] = [];
  for (const key of keys) {
    try {
      const dir = await getHandle(key);
      if (dir) out.push({ key, dir });
    } catch {
      /* unbound slot — skip */
    }
  }
  return out;
}

/** The architecture carried by a stored Citivai metadata sidecar. The scan
    writes the full model JSON, so `modelVersions[].baseModel` is available even
    when the weights header cannot be read (ckpt, permissions, big files). */
function baseModelFromSidecar(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const obj = json as Record<string, unknown>;
  const own = typeof obj.baseModel === 'string' ? obj.baseModel.trim() : '';
  if (own) return own;
  const versions = obj.modelVersions;
  if (Array.isArray(versions)) {
    for (const v of versions) {
      const bm = (v as Record<string, unknown> | null)?.baseModel;
      if (typeof bm === 'string' && bm.trim()) return bm.trim();
    }
  }
  return '';
}

/** Sidecar files living next to a model. Civitai's scan writes
    `<base>.metadata.json`; StabilityMatrix writes `<base>.cm-info.json`. */
const META_SUFFIXES = ['.metadata.json', '.cm-info.json'] as const;
const IMAGE_SUFFIXES = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.preview.png',
  '.preview.jpeg',
  '.preview.jpg',
  '.preview.webp',
] as const;

async function readModelSidecar(
  dir: FileSystemDirectoryHandle,
  base: string,
): Promise<{ data: Record<string, unknown>; name: string } | null> {
  for (const suffix of META_SUFFIXES) {
    try {
      const handle = await dir.getFileHandle(`${base}${suffix}`);
      const parsed = JSON.parse(await (await handle.getFile()).text());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { data: parsed as Record<string, unknown>, name: `${base}${suffix}` };
      }
    } catch {
      /* missing or malformed — try the other format */
    }
  }
  return null;
}

async function findSidecarImage(dir: FileSystemDirectoryHandle, base: string): Promise<string | null> {
  for (const ext of IMAGE_SUFFIXES) {
    if (await fileExists(dir, `${base}${ext}`)) return `${base}${ext}`;
  }
  return null;
}

export interface SidecarIdentity {
  modelId: number;
  versionId: number;
  name: string;
  baseModel: string;
  hash: string;
}

/** Identify a model from a sidecar without hashing it. Understands both the
    Civitai model/version JSON and StabilityMatrix's `.cm-info.json`. */
export function identityFromSidecar(
  data: Record<string, unknown>,
  filename: string,
): SidecarIdentity | null {
  const num = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const hashOf = (hashes: unknown) => {
    if (!hashes || typeof hashes !== 'object') return '';
    const sha = (hashes as Record<string, unknown>).SHA256;
    return typeof sha === 'string' ? sha.trim().toLowerCase().slice(0, 12) : '';
  };

  // StabilityMatrix ConnectedModelInfo (PascalCase fields).
  if (data.ModelId || data.VersionId) {
    const modelId = num(data.ModelId);
    const versionId = num(data.VersionId);
    if (!modelId || !versionId) return null;
    return {
      modelId,
      versionId,
      name: String(data.ModelName || '').trim(),
      baseModel: String(data.BaseModel || '').trim(),
      hash: hashOf(data.Hashes),
    };
  }

  // StabilityMatrix model cache: `<name>.metadata.json` with a nested
  // `civitai` version object next to snake_case file fields.
  const civitai = data.civitai;
  if (civitai && typeof civitai === 'object' && !Array.isArray(civitai)) {
    const c = civitai as Record<string, unknown>;
    const modelId = num(c.modelId);
    const versionId = num(c.id);
    if (modelId && versionId) {
      return {
        modelId,
        versionId,
        name: String(data.model_name || c.name || '').trim(),
        baseModel: String(c.baseModel || data.base_model || '').trim(),
        hash: typeof data.sha256 === 'string' ? data.sha256.trim().toLowerCase().slice(0, 12) : '',
      };
    }
  }

  const versions = Array.isArray(data.modelVersions)
    ? (data.modelVersions as Array<Record<string, unknown>>)
    : [];
  if (versions.length) {
    const leaf = filename.toLowerCase();
    const matching = versions.find((version) => {
      const files = version.files;
      return (
        Array.isArray(files) &&
        files.some(
          (file) =>
            typeof (file as Record<string, unknown>)?.name === 'string' &&
            String((file as Record<string, unknown>).name).split('/').pop()?.toLowerCase() === leaf,
        )
      );
    });
    const version = matching ?? versions[0];
    const modelId = num(data.id) || num(version?.modelId);
    const versionId = num(version?.id);
    if (!modelId || !versionId) return null;
    const files = Array.isArray(version?.files) ? (version.files as Array<Record<string, unknown>>) : [];
    const primary = files.find(
      (file) => String(file?.name || '').split('/').pop()?.toLowerCase() === leaf,
    ) ?? files[0];
    return {
      modelId,
      versionId,
      name: String(data.name || version?.name || '').trim(),
      baseModel: String(version?.baseModel || '').trim(),
      hash: hashOf(primary?.hashes),
    };
  }

  // Civitai version JSON (the shape returned by the by-hash lookup).
  if (data.id && data.modelId) {
    const model = (data.model && typeof data.model === 'object' ? data.model : {}) as Record<string, unknown>;
    const files = Array.isArray(data.files) ? (data.files as Array<Record<string, unknown>>) : [];
    const primary = files.find(
      (file) => String(file?.name || '').split('/').pop()?.toLowerCase() === filename.toLowerCase(),
    ) ?? files[0];
    return {
      modelId: num(data.modelId),
      versionId: num(data.id),
      name: String(model.name || data.name || '').trim(),
      baseModel: String(data.baseModel || '').trim(),
      hash: hashOf(primary?.hashes),
    };
  }
  return null;
}

/** Last-resort architecture hint from the user's own folder/file naming.
    Downloads land in a `<base_model_slug>/` folder (`sdxl_1_0`, `flux_1_d`),
    and many people tag files (`*_pony`, `*XL`); only explicit tokens match. */
export function baseModelFromPath(path: string): string {
  const text = path.toLowerCase();
  const word = (token: string) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(text);
  if (word('flux')) return 'Flux.1 D';
  if (word('pony') || word('ponyxl')) return 'Pony';
  if (word('noobai')) return 'NoobAI';
  if (word('illustrious')) return 'Illustrious';
  if (word('sdxl') || word('sd_xl') || word('xl_1_0') || word('xl_base')) return 'SDXL 1.0';
  if (word('sd3') || word('sd_3')) return 'SD 3';
  if (word('sd15') || word('sd_15') || word('sd1_5') || /sd[\s._-]?1[._-]5/.test(text)) return 'SD 1.5';
  if (word('sd21') || word('sd_21') || word('sd2_1')) return 'SD 2.1';
  return '';
}

/** Resolve the architecture for a scanned record that has none stored. Tries
    the record's own folder first, then every other bound folder of the same
    category (records saved before per-folder keys existed carry the wrong
    `dir_key`), reading `<name>.metadata.json` before the weights header. */
export async function resolveRecordBaseModel(record: {
  dirKey: string;
  filename: string;
  type: string;
  dirPath?: string;
}): Promise<{ baseModel: string; dirKey: string; dirPath: string } | null> {
  const roots = await boundFolders(record.type);
  const ordered = [
    ...roots.filter((r) => r.key === record.dirKey),
    ...roots.filter((r) => r.key !== record.dirKey),
  ];
  const parts = record.filename.split('/').filter(Boolean);
  const leaf = parts[parts.length - 1] ?? '';
  for (const root of parts.length > 0 ? ordered : []) {
    try {
      let cur = root.dir;
      for (const part of parts.slice(0, -1)) cur = await cur.getDirectoryHandle(part);
      const file = await (await cur.getFileHandle(leaf)).getFile();
      const sidecar = `${leaf.replace(/\.[^.]+$/, '')}.metadata.json`;
      try {
        const meta = JSON.parse(await (await (await cur.getFileHandle(sidecar)).getFile()).text());
        const fromMeta = baseModelFromSidecar(meta);
        if (fromMeta) {
          return { baseModel: fromMeta, dirKey: root.key, dirPath: getDirectories()[root.key] ?? '' };
        }
      } catch {
        /* no sidecar — fall through to the weights */
      }
      const inferred = await inferBaseModel(file);
      if (inferred) {
        return { baseModel: inferred, dirKey: root.key, dirPath: getDirectories()[root.key] ?? '' };
      }
    } catch {
      /* file not in this folder — try the next slot */
    }
  }
  // Nothing readable: fall back to the folder/file naming so the chip stops
  // saying "unknown" for models the user already labelled themselves.
  const fromPath = baseModelFromPath(`${record.dirPath ?? ''}/${record.filename}`);
  if (fromPath) {
    const own = roots.find((r) => r.key === record.dirKey);
    return { baseModel: fromPath, dirKey: record.dirKey, dirPath: own ? getDirectories()[record.dirKey] ?? '' : '' };
  }
  return null;
}

/** Scan one Settings type across every saved folder. Returns files identified;
    appends seen keys for cleanup. */
export async function scanDir(
  type: string,
  resolveAll: (type: string) => Promise<ScanRoot[]>,
  seen: Set<string>,
  onMsg: (msg: string) => void,
  onProgress?: (done: number, total: number, message: string) => void,
): Promise<number> {
  const roots = await resolveAll(type);
  if (roots.length === 0) return 0;

  // Recursive: users sort models into subfolders. Sidecars stay next to
  // their model file; seen keys use paths relative to the linked folder.
  const files: {
    rel: string;
    handle: FileSystemFileHandle;
    dir: FileSystemDirectoryHandle;
    dirKey: string;
    dirPath: string;
  }[] = [];
  const walkDir = async (
    d: FileSystemDirectoryHandle,
    prefix: string,
    root: ScanRoot,
    out: typeof files,
  ) => {
    const it = (d as unknown as { values: ValuesFn }).values();
    for await (const [name, handle] of it) {
      if (handle.kind === 'directory') {
        await walkDir(handle as unknown as FileSystemDirectoryHandle, `${prefix}${name}/`, root, out);
      } else if (handle.kind === 'file' && MODEL_EXTS.some((e) => name.toLowerCase().endsWith(e))) {
        out.push({
          rel: `${prefix}${name}`,
          handle: handle as FileSystemFileHandle,
          dir: d,
          dirKey: root.key,
          dirPath: getDirectories()[root.key] ?? '',
        });
      }
    }
  };
  for (const root of roots) {
    if (!(await ensurePermission(root.dir, 'readwrite'))) {
      onMsg(`${type}: permission denied`);
      continue;
    }
    await walkDir(root.dir, '', root, files);
  }

  let updated = 0;
  onProgress?.(0, files.length, `${type}: ${files.length} file${files.length === 1 ? '' : 's'} found`);

  // Pass 1 — sidecars only. A folder that already holds a Civitai metadata
  // file or a StabilityMatrix cm-info file (plus an image) is recorded without
  // touching the weights. Hashing is deferred until the tree is fully walked.
  const pending: typeof files = [];
  const sidecarData = new Map<string, Record<string, unknown>>();
  let checked = 0;
  for (const f of files) {
    if (isScanCancelled()) throw new Error('Scan cancelled');
    const name = f.rel.split('/').pop() ?? f.rel;
    const base = name.replace(/\.[^.]+$/, '');
    seen.add(`${f.dirKey}/${f.rel}`);
    checked += 1;
    const sidecar = await readModelSidecar(f.dir, base);
    if (sidecar) sidecarData.set(f.rel, sidecar.data);
    const identity = sidecar ? identityFromSidecar(sidecar.data, name) : null;
    if (!identity) {
      pending.push(f);
    } else {
      const imageName = await findSidecarImage(f.dir, base);
      let size = 0;
      let file: File | null = null;
      try {
        file = await f.handle.getFile();
        size = file.size;
      } catch {
        /* unreadable — list by name only */
      }
      // Sidecar architecture first; the weights header is cheap (8-byte
      // length + JSON) and avoids hashing the file just for the chip.
      let baseModel = identity.baseModel;
      if (!baseModel && file) {
        try {
          baseModel = await inferBaseModel(file);
        } catch {
          /* unreadable header */
        }
      }
      upsertScanned({
        modelId: identity.modelId,
        versionId: identity.versionId,
        name: identity.name || base,
        type,
        baseModel: baseModel || baseModelFromPath(`${f.dirPath}/${f.rel}`),
        dirKey: f.dirKey,
        dirPath: f.dirPath,
        filename: f.rel,
        hash: identity.hash,
        size,
        imageName,
        identified: true,
        scannedAt: Date.now(),
      });
      updated += 1;
      onMsg(`${type}: ${name} read from ${sidecar?.name ?? 'sidecar'}`);
    }
    onProgress?.(checked, files.length, `${type}: reading sidecars (${checked}/${files.length})`);
  }

  // Pass 2 — list the remaining files as unidentified. Hashing is a separate,
  // explicit action ("Identify models"), so a scan stays fast and never calls
  // Civitai on its own.
  let done = 0;
  for (const f of pending) {
    if (isScanCancelled()) throw new Error('Scan cancelled');
    const name = f.rel.split('/').pop() ?? f.rel;
    const base = name.replace(/\.[^.]+$/, '');
    done += 1;
    const progressMsg = `${type}: listing ${f.rel} (${done}/${pending.length})`;
    onMsg(progressMsg);
    onProgress?.(done, pending.length, progressMsg);
    let size = 0;
    let file: File | null = null;
    try {
      file = await f.handle.getFile();
      size = file.size;
    } catch {
      /* unreadable — list by name only */
    }
    let inferred = '';
    if (file) {
      try {
        inferred = await inferBaseModel(file);
      } catch {
        /* unreadable header */
      }
    }
    const imageName = await findSidecarImage(f.dir, base);
    const meta = sidecarData.get(f.rel) ?? {};
    const displayName = String(meta.model_name ?? '').trim() || base;
    const metaBase = String(meta.base_model ?? '').trim();
    upsertScanned({
      modelId: 0,
      versionId: pathId(`${f.dirKey}/${f.rel}`),
      name: displayName,
      type,
      baseModel: metaBase || inferred || baseModelFromPath(`${f.dirPath}/${f.rel}`),
      dirKey: f.dirKey,
      dirPath: f.dirPath,
      filename: f.rel,
      hash: '',
      size,
      imageName,
      identified: false,
      scannedAt: Date.now(),
    });
    updated += 1;
  }
  onMsg(`${type}: scanned ${files.length} files, updated ${updated} models.`);
  onProgress?.(files.length, files.length, `${type}: scanned ${files.length} files, updated ${updated} models.`);
  return updated;
}

/** Hash + Civitai-match local scan records saved as unidentified. */
export async function identifyUnknownModels(
  onMsg: (msg: string) => void,
  onProgress?: (done: number, total: number, message: string) => void,
): Promise<number> {
  const records = loadScanned().filter((record) => !record.identified);
  const total = records.length;
  if (total === 0) {
    onMsg('No unidentified models to check.');
    onProgress?.(0, 0, 'No unidentified models to check.');
    return 0;
  }
  let identified = 0;
  let done = 0;
  const rootsByType = new Map<string, ScanRoot[]>();
  for (const record of records) {
    if (isScanCancelled()) throw new Error('Identification cancelled');
    done += 1;
    const message = `Identifying ${record.filename} (${done}/${total})`;
    onMsg(message);
    onProgress?.(done, total, message);
    try {
      let roots = rootsByType.get(record.type);
      if (!roots) {
        roots = await boundFolders(record.type);
        rootsByType.set(record.type, roots);
      }
      const root = roots.find((r) => r.key === record.dirKey) ?? roots[0];
      if (!root || !(await ensurePermission(root.dir, 'read'))) continue;
      let dir = root.dir;
      const parts = record.filename.split('/').filter(Boolean);
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      const leaf = parts[parts.length - 1] ?? record.filename;
      const file = await (await dir.getFileHandle(leaf)).getFile();
      const hash = await sha256Hex(file);
      const version = await fetchVersionByHash(hash);
      const base = leaf.replace(/\.[^.]+$/, '');
      const imageName = await findSidecarImage(dir, base);
      upsertScanned({
        modelId: version.modelId ?? 0,
        versionId: version.id,
        name: version.model?.name ?? record.name,
        type: record.type,
        baseModel:
          version.baseModel ||
          (await inferBaseModel(file)) ||
          baseModelFromPath(`${record.dirPath}/${record.filename}`),
        dirKey: record.dirKey,
        dirPath: record.dirPath,
        filename: record.filename,
        hash: hash.slice(0, 12),
        size: file.size,
        imageName,
        identified: true,
        scannedAt: Date.now(),
      });
      identified += 1;
    } catch {
      onMsg(`No Civitai match for ${record.filename}`);
    }
  }
  const summary = `Identified ${identified} of ${total} unmatched models.`;
  onMsg(summary);
  onProgress?.(total, total, summary);
  return identified;
}

const RENAME_SUFFIXES = [
  '.metadata.json',
  '.cm-info.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.preview.png',
  '.preview.jpeg',
  '.preview.jpg',
  '.preview.webp',
] as const;

/** Rename a browser-scanned model file, its sidecars and previews. */
export async function renameScannedFiles(input: {
  type: string;
  dirKey?: string;
  filename: string;
  name: string;
}): Promise<{ filename: string; path: string }> {
  const roots = await boundFolders(input.type);
  const root = roots.find((r) => r.key === input.dirKey) ?? roots[0];
  if (!root || !(await ensurePermission(root.dir, 'readwrite'))) {
    throw new Error('Reconnect this model folder to rename files.');
  }
  let dir = root.dir;
  const parts = input.filename.split('/').filter(Boolean);
  const leaf = parts.pop() ?? input.filename;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);

  const ext = leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.')) : '';
  let base = input.name.trim();
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
  if (!base || base === '.' || base === '..' || /[\\/\0]/.test(base)) {
    throw new Error('Enter a valid file name (no slashes).');
  }
  const oldBase = ext ? leaf.slice(0, -ext.length) : leaf;
  const newFilename = [...parts, `${base}${ext}`].join('/');
  if (base === oldBase) return { filename: input.filename, path: `/${newFilename}` };

  const renames: Array<{ old: string; next: string }> = [];
  // The model file keeps its own extension (oldBase is extension-less).
  let modelClash = true;
  try {
    await dir.getFileHandle(`${base}${ext}`);
  } catch {
    modelClash = false;
  }
  if (modelClash) throw new Error(`${base}${ext} already exists.`);
  renames.push({ old: leaf, next: `${base}${ext}` });
  for (const suffix of RENAME_SUFFIXES) {
    const old = `${oldBase}${suffix}`;
    try {
      await dir.getFileHandle(old);
    } catch {
      continue;
    }
    const next = `${base}${suffix}`;
    if (old === next) continue;
    let clash = true;
    try {
      await dir.getFileHandle(next);
    } catch {
      clash = false;
    }
    if (clash) throw new Error(`${next} already exists.`);
    renames.push({ old, next });
  }
  if (renames.length === 0) throw new Error('Nothing to rename.');

  for (const { old, next } of renames) {
    const handle = await dir.getFileHandle(old);
    const movable = handle as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
    if (typeof movable.move === 'function') {
      await movable.move(next);
      continue;
    }
    const file = await handle.getFile();
    const target = await dir.getFileHandle(next, { create: true });
    const writable = await target.createWritable();
    await writable.write(file);
    await writable.close();
    await dir.removeEntry(old);
  }
  renameScannedFileRecord(input.dirKey ?? root.key, input.filename, newFilename);
  return { filename: newFilename, path: `/${newFilename}` };
}

export interface ScannedMatch {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  baseModel: string;
}

/** Hash one browser-scanned file and return its Civitai match (or null). */
export async function identifyScannedRecord(record: {
  type: string;
  dirKey?: string;
  filename: string;
  dirPath?: string;
  name?: string;
}): Promise<ScannedMatch | null> {
  const roots = await boundFolders(record.type);
  const root = roots.find((r) => r.key === record.dirKey) ?? roots[0];
  if (!root || !(await ensurePermission(root.dir, 'read'))) return null;
  let dir = root.dir;
  const parts = record.filename.split('/').filter(Boolean);
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  const leaf = parts[parts.length - 1] ?? record.filename;
  const file = await (await dir.getFileHandle(leaf)).getFile();
  const hash = await sha256Hex(file);
  const version = await fetchVersionByHash(hash);
  return {
    modelId: version.modelId ?? 0,
    versionId: version.id,
    name: version.model?.name ?? record.name ?? leaf,
    type: record.type,
    baseModel:
      version.baseModel ||
      (await inferBaseModel(file)) ||
      baseModelFromPath(`${record.dirPath ?? ''}/${record.filename}`),
  };
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
