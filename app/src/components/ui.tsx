const TYPE_BADGE: Record<string, string> = {
  Checkpoint: 'bg-badge-checkpoint/15 border-badge-checkpoint/30 text-[#818cf8]',
  LORA: 'bg-badge-lora/15 border-badge-lora/30 text-[#a78bfa]',
  LoCon: 'bg-badge-lora/15 border-badge-lora/30 text-[#a78bfa]',
  Flux: 'bg-badge-flux/15 border-badge-flux/30 text-[#f472b6]',
  SDXL: 'bg-badge-sdxl/15 border-badge-sdxl/30 text-[#22d3ee]',
  VAE: 'bg-badge-sdxl/15 border-badge-sdxl/30 text-[#22d3ee]',
  Controlnet: 'bg-badge-sdxl/15 border-badge-sdxl/30 text-[#22d3ee]',
};

/** Built-in hue per model type — mirrors the TYPE_BADGE classes above so the
    base-model chip can be tinted exactly like the type badge/filters. */
const TYPE_HUE: Record<string, string> = {
  Checkpoint: '#818cf8',
  LORA: '#a78bfa',
  LoCon: '#a78bfa',
  Flux: '#f472b6',
  SDXL: '#22d3ee',
  VAE: '#22d3ee',
  Controlnet: '#22d3ee',
};

/** Accent for a model type: the user's category color wins, else the
    built-in hue, else undefined (grey). */
export function typeHue(type?: string, color?: string): string | undefined {
  if (color) return color;
  return type ? TYPE_HUE[type] : undefined;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgba(144,143,160,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** A category badge. Custom `color` overrides the built-in hue; otherwise the
    built-in map applies, falling back to grey. */
export function TypeBadge({ type, color }: { type: string; color?: string }) {
  const cls =
    TYPE_BADGE[type] ?? 'bg-white/5 border-white/15 text-ink-muted';
  const style = color
    ? {
        color,
        borderColor: hexToRgba(color, 0.45),
        backgroundColor: hexToRgba(color, 0.13),
      }
    : undefined;
  return (
    <span
      className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${cls}`}
      style={style}
    >
      {type}
    </span>
  );
}

/** Base-model chip: the architecture a weight targets (SDXL 1.0, Illustrious,
    Flux.1 D…). Local cards use this in place of the old socket pill, and the
    Explorer / Home cards show the same chip so every model card reads alike.
    Tinted with the card's model-type accent, like the type badge/filters;
    unknown stays grey so a missing answer is obvious. */
export function BaseModelBadge({
  baseModel,
  fallback,
  type,
  color,
  className = '',
}: {
  baseModel?: string | null;
  fallback?: string;
  /** Model type of the card — supplies the accent when `color` is absent. */
  type?: string;
  /** Explicit accent (e.g. the user's category color). */
  color?: string;
  className?: string;
}) {
  const value = (baseModel ?? '').trim();
  const display = value || (fallback ?? '').trim() || 'unknown';
  const known = display !== 'unknown';
  const hue = known ? typeHue(type, color) : undefined;
  const style = hue
    ? {
        color: hue,
        borderColor: hexToRgba(hue, 0.45),
        backgroundColor: hexToRgba(hue, 0.13),
      }
    : undefined;
  return (
    <span
      className={`inline-flex max-w-full items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
        hue
          ? ''
          : known
            ? 'border-white/10 bg-white/5 text-ink-muted'
            : 'border-white/10 bg-white/5 text-ink-faint'
      } ${className}`}
      style={style}
      title={known ? display : 'Unknown'}
    >
      <span className="truncate">{display}</span>
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
