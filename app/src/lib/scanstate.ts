/* Browser-side scan progress shared between Settings (which runs the scan)
   and the floating scan panel mounted in the app shell. Server scans are read
   from /api/downloads/status by the panel itself; this store covers the
   File System Access path that only exists inside the tab. */

export interface LocalScanState {
  /** Folder scans list unknown files; identification hashes + matches them. */
  kind: 'scan' | 'identify';
  /** Human label: the folder type being scanned, or "all folders". */
  label: string;
  current: number;
  total: number;
  message: string;
  /** Epoch seconds, so the panel can show elapsed time like plugin tasks. */
  startedAt: number;
}

type Listener = (state: LocalScanState | null) => void;

let state: LocalScanState | null = null;
let cancelRequested = false;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener(state));
}

export function getScanState(): LocalScanState | null {
  return state;
}

export function beginScan(label: string, kind: LocalScanState['kind'] = 'scan'): void {
  cancelRequested = false;
  state = {
    kind,
    label,
    current: 0,
    total: 0,
    message: kind === 'identify' ? 'Preparing identification…' : 'Preparing scan…',
    startedAt: Date.now() / 1000,
  };
  emit();
}

export function updateScan(patch: Partial<Omit<LocalScanState, 'startedAt'>>): void {
  if (!state) return;
  state = { ...state, ...patch };
  emit();
}

/** Ask the running browser scan/identify loop to stop at its next step. */
export function requestScanCancel(): void {
  cancelRequested = true;
  if (state) {
    state = { ...state, message: 'Cancelling…' };
    emit();
  }
}

export function isScanCancelled(): boolean {
  return cancelRequested;
}

export function finishScan(message = 'Scan complete.'): void {
  if (!state) return;
  state = { ...state, current: state.total, message };
  const done = state;
  emit();
  // Keep the completed line visible briefly, then hide the panel.
  setTimeout(() => {
    if (state === done) {
      state = null;
      emit();
    }
  }, 4000);
}

export function subscribeScanState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
