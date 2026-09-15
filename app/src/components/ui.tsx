import type { SocketState } from '../data/models';

const TYPE_BADGE: Record<string, string> = {
  Checkpoint: 'bg-badge-checkpoint/15 border-badge-checkpoint/30 text-[#818cf8]',
  LORA: 'bg-badge-lora/15 border-badge-lora/30 text-[#a78bfa]',
  LoCon: 'bg-badge-lora/15 border-badge-lora/30 text-[#a78bfa]',
  Flux: 'bg-badge-flux/15 border-badge-flux/30 text-[#f472b6]',
  SDXL: 'bg-badge-sdxl/15 border-badge-sdxl/30 text-[#22d3ee]',
  VAE: 'bg-badge-sdxl/15 border-badge-sdxl/30 text-[#22d3ee]',
  Controlnet: 'bg-badge-sdxl/15 border-badge-sdxl/30 text-[#22d3ee]',
};

export function TypeBadge({ type }: { type: string }) {
  const cls =
    TYPE_BADGE[type] ?? 'bg-white/5 border-white/15 text-ink-muted';
  return (
    <span
      className={`rounded-[3px] border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${cls}`}
    >
      {type}
    </span>
  );
}

const SOCKET_STYLE: Record<SocketState, { dot: string; text: string; label: string }> = {
  rw: { dot: 'bg-status-active', text: 'text-status-active', label: 'socket: rw' },
  ro: { dot: 'bg-status-warning', text: 'text-[#fcd34d]', label: 'socket: ro' },
  missing: { dot: 'bg-status-alert', text: 'text-[#f87171]', label: 'socket: missing' },
};

export function SocketPill({ socket }: { socket: SocketState }) {
  const s = SOCKET_STYLE[socket];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[3px] border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${s.text}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.dot}`}
        style={socket === 'rw' ? { boxShadow: '0 0 8px rgba(16,185,129,0.5)' } : undefined}
      />
      {s.label}
    </span>
  );
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink">
      <span className="text-status-warning">★</span>
      {rating > 0 ? rating.toFixed(1) : '—'}
    </span>
  );
}
