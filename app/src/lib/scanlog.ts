/* Shared scan-log lines. Scan runs from Model dirs; the log renders as its
   own block on the System tab. */

type Listener = (lines: string[]) => void;

let lines: string[] = [];
const listeners = new Set<Listener>();

export function getScanLog(): string[] {
  return lines;
}

export function pushScanLog(line: string): void {
  lines = [...lines.slice(-99), line];
  listeners.forEach((l) => l(lines));
}

export function clearScanLog(): void {
  lines = [];
  listeners.forEach((l) => l(lines));
}

export function subscribeScanLog(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
