/* Scanned-library records. Mirrors OldCode Download rows
   (model_id, version_id, name, type, files JSON). */

export interface ScannedModel {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  dirKey: string;
  dirPath: string;
  filename: string;
  hash: string;
  size: number;
  imageName: string | null;
  scannedAt: number;
}

const KEY = 'sdcodex.library.v1';

export function loadScanned(): ScannedModel[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(list: ScannedModel[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota — drop oldest */
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(-200)));
    } catch {
      /* ignore */
    }
  }
}

export function upsertScanned(entry: ScannedModel): ScannedModel[] {
  const list = loadScanned().filter(
    (e) => !(e.modelId === entry.modelId && e.versionId === entry.versionId),
  );
  const next = [...list, entry];
  persist(next);
  return next;
}

/** Drop records whose files vanished — mirrors OldCode's missing-model cleanup. */
export function pruneScanned(keep: Set<string>): { list: ScannedModel[]; removed: number } {
  const list = loadScanned();
  const next = list.filter((e) => keep.has(`${e.dirKey}/${e.filename}`));
  persist(next);
  return { list: next, removed: list.length - next.length };
}

/** Forget one record (modal Delete for local entries). */
export function deleteScanned(modelId: number, versionId: number): ScannedModel[] {
  const next = loadScanned().filter((e) => !(e.modelId === modelId && e.versionId === versionId));
  persist(next);
  return next;
}
