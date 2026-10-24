/* Scanned-library records. Mirrors OldCode Download rows
   (model_id, version_id, name, type, files JSON). */

export interface ScannedModel {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  baseModel: string;
  dirKey: string;
  dirPath: string;
  filename: string;
  hash: string;
  size: number;
  imageName: string | null;
  /** False when Civitai had no match — shown with a placeholder. */
  identified: boolean;
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
  // Replace by id *and* by file: a rescan that identifies a file must not leave
  // its old unidentified (stand-in id) record behind as a duplicate card.
  const list = loadScanned().filter(
    (e) =>
      !(e.modelId === entry.modelId && e.versionId === entry.versionId) &&
      !(e.dirKey === entry.dirKey && e.filename === entry.filename),
  );
  const next = [...list, entry];
  persist(next);
  return next;
}

/** Fill in the architecture after reading it from the weights on disk. */
/** Point a scanned record at renamed files on disk (model + preview). */
export function renameScannedFileRecord(
  dirKey: string,
  oldFilename: string,
  newFilename: string,
): void {
  const list = loadScanned();
  const index = list.findIndex((e) => e.dirKey === dirKey && e.filename === oldFilename);
  if (index < 0) return;
  const entry = list[index];
  const oldLeaf = oldFilename.split('/').pop() ?? oldFilename;
  const newLeaf = newFilename.split('/').pop() ?? newFilename;
  const oldBase = oldLeaf.replace(/\.[^.]+$/, '');
  const newBase = newLeaf.replace(/\.[^.]+$/, '');
  const imageName =
    entry.imageName && entry.imageName.startsWith(oldBase)
      ? `${newBase}${entry.imageName.slice(oldBase.length)}`
      : entry.imageName;
  list[index] = { ...entry, filename: newFilename, imageName };
  persist(list);
}

export function setScannedBaseModel(modelId: number, versionId: number, baseModel: string): boolean {
  const list = loadScanned();
  const index = list.findIndex((e) => e.modelId === modelId && e.versionId === versionId);
  if (index < 0 || list[index].baseModel) return false;
  list[index] = { ...list[index], baseModel };
  persist(list);
  return true;
}

/** Same, keyed by file path — handles records that predate base-model capture
    and repairs the folder binding when the file was found in another slot
    (`dir_<Type>__2` instead of the `dir_<Type>` they were saved under). */
export function setScannedBaseModelByFile(
  dirKey: string,
  filename: string,
  baseModel: string,
  found?: { dirKey?: string; dirPath?: string },
): boolean {
  const list = loadScanned();
  const index = list.findIndex((e) => e.dirKey === dirKey && e.filename === filename);
  if (index < 0 || list[index].baseModel) return false;
  list[index] = {
    ...list[index],
    baseModel,
    dirKey: found?.dirKey || dirKey,
    dirPath: found?.dirPath || list[index].dirPath,
  };
  persist(list);
  return true;
}

export function setScannedImageName(dirKey: string, filename: string, imageName: string): boolean {
  const list = loadScanned();
  const index = list.findIndex((e) => e.dirKey === dirKey && e.filename === filename);
  if (index < 0) return false;
  list[index] = { ...list[index], imageName };
  persist(list);
  return true;
}

/** Adopt a Civitai match for a previously-unknown record (keeps its file). */
export function adoptScannedMatch(
  oldModelId: number,
  oldVersionId: number,
  patch: { modelId: number; versionId: number; name: string; type: string; baseModel: string },
): ScannedModel[] {
  const list = loadScanned();
  const old = list.find((e) => e.modelId === oldModelId && e.versionId === oldVersionId);
  const rest = list.filter((e) => !(e.modelId === oldModelId && e.versionId === oldVersionId));
  if (!old) {
    persist(rest);
    return rest;
  }
  const next = [
    ...rest,
    { ...old, ...patch, identified: true, scannedAt: Date.now() },
  ];
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
