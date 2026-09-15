export interface QueueItem {
  id: string;
  name: string;
  detail: string;
  downloadUrl: string;
  addedAt: number;
  status: 'queued' | 'downloading' | 'done';
  /** 0-100. Absent until the backend worker reports progress. */
  progress?: number;
  /** Backend contract: mirrors DownloadManager.add_task(model_id, version_id). */
  modelId?: number;
  versionId?: number;
  baseModel?: string;
}

const KEY = 'sdcodex.queue.v1';
const PAUSED_KEY = 'sdcodex.queue.paused.v1';

export function loadQueue(): QueueItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(items: QueueItem[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function addToQueue(item: Omit<QueueItem, 'addedAt' | 'status'>): QueueItem[] {
  const items = loadQueue();
  if (items.some((i) => i.id === item.id)) return items;
  const next = [...items, { ...item, addedAt: Date.now(), status: 'queued' as const }];
  saveQueue(next);
  return next;
}

export function removeFromQueue(id: string): QueueItem[] {
  const next = loadQueue().filter((i) => i.id !== id);
  saveQueue(next);
  return next;
}

export function clearQueue(): QueueItem[] {
  saveQueue([]);
  return [];
}

export function clearCompleted(): QueueItem[] {
  const next = loadQueue().filter((i) => i.status !== 'done');
  saveQueue(next);
  return next;
}

export function isPaused(): boolean {
  try {
    return localStorage.getItem(PAUSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPaused(paused: boolean): void {
  try {
    localStorage.setItem(PAUSED_KEY, paused ? '1' : '0');
  } catch {
    /* private mode — ignore */
  }
}
