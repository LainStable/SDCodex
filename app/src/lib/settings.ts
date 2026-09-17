/* Client-side settings store. Keys mirror OldCode's Setting table
   (dir_<type>, api key per user) so the backend can adopt these values as-is. */

import { apiGet, apiPost, backendAvailable } from './backend';

export const MODEL_TYPES = [
  'Checkpoint',
  'Embedding',
  'Hypernetwork',
  'AestheticGradient',
  'LORA',
  'LyCORIS',
  'DoRA',
  'Controlnet',
  'Upscaler',
  'Motion',
  'VAE',
  'Poses',
  'Wildcards',
  'Workflows',
  'Detection',
  'Other',
] as const;

const API_KEY = 'sdcodex.apiKey.v1';
const API_USER = 'sdcodex.apiUser.v1';
const DIRS_KEY = 'sdcodex.dirs.v1';
const CUSTOM_DIRS_KEY = 'sdcodex.customDirs.v1';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — ignore */
  }
}

export function getApiKey(): string {
  return read(API_KEY) ?? '';
}

export function setApiKey(key: string): void {
  write(API_KEY, key.trim());
}

export function clearApiKey(): void {
  try {
    localStorage.removeItem(API_KEY);
    localStorage.removeItem(API_USER);
  } catch {
    /* ignore */
  }
}

/** Username confirmed by the last successful key validation. */
export function getApiUser(): string {
  return read(API_USER) ?? '';
}

export function setApiUser(username: string): void {
  write(API_USER, username);
}

/** Mirrors OldCode Setting dir_<type> rows. */
export function getDirectories(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DIRS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  return {};
}

export function setDirectory(modelType: string, path: string): void {
  const dirs = getDirectories();
  dirs[`dir_${modelType}`] = path.trim();
  write(DIRS_KEY, JSON.stringify(dirs));
}

export function getCustomDirs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CUSTOM_DIRS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  return {};
}

export function setCustomDir(label: string, path: string): void {
  const dirs = getCustomDirs();
  dirs[label] = path.trim();
  write(CUSTOM_DIRS_KEY, JSON.stringify(dirs));
}

export function deleteCustomDir(label: string): void {
  const dirs = getCustomDirs();
  delete dirs[label];
  write(CUSTOM_DIRS_KEY, JSON.stringify(dirs));
}

/** All paths for a type: dir_<Type>, dir_<Type>__1, dir_<Type>__2 … */
export function getDirPaths(modelType: string): string[] {
  const dirs = getDirectories();
  const out: string[] = [];
  const base = dirs[`dir_${modelType}`] ?? '';
  if (base.trim()) out.push(base);
  const extras = Object.keys(dirs)
    .filter((k) => k.startsWith(`dir_${modelType}__`))
    .sort()
    .map((k) => dirs[k])
    .filter((v) => v && v.trim());
  return [...out, ...extras];
}

/** Append another path slot for a type. Returns the new key. */
export function addDirPath(modelType: string, path: string): string {
  const dirs = getDirectories();
  let i = 1;
  while (`dir_${modelType}__${i}` in dirs) i += 1;
  const key = `dir_${modelType}__${i}`;
  const next = { ...dirs, [key]: path.trim() };
  try {
    localStorage.setItem('sdcodex.dirs.v1', JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return key;
}

export function removeDirPath(key: string): void {
  const dirs = getDirectories();
  delete dirs[key];
  try {
    localStorage.setItem('sdcodex.dirs.v1', JSON.stringify(dirs));
  } catch {
    /* ignore */
  }
}

/** Default target dir for a type, preferring configured dir — mirrors downloader.py. */
export function targetDirFor(modelType: string, baseModel: string): string {
  const configured = getDirectories()[`dir_${modelType}`];
  if (configured) return configured;
  const slug = baseModel.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `/models/${modelType.toLowerCase()}/${slug}/`;
}

/** Pull server settings into the local cache (backend wins when reachable). */
export async function pullSettings(): Promise<boolean> {
  try {
    if (!(await backendAvailable())) return false;
    const s = await apiGet<{ dirs: Record<string, string>; civitaiApiKey: string }>('/settings');
    write('sdcodex.dirs.v1', JSON.stringify(s.dirs ?? {}));
    if (s.civitaiApiKey) {
      write('sdcodex.apiKey.v1', s.civitaiApiKey);
    }
    return true;
  } catch {
    return false;
  }
}

/** Push the local cache to the server (best-effort, keeps local on failure). */
export async function pushSettings(): Promise<void> {
  try {
    if (!(await backendAvailable())) return;
    await apiPost('/settings', { dirs: getDirectories(), civitaiApiKey: getApiKey() });
  } catch {
    /* standalone mode — local cache stands */
  }
}
