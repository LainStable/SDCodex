import { useEffect, useRef, useState } from 'react';

/** Floating avatar cropper: drag to pan, slider to zoom, square crop out.
    Emits a 256px JPEG data-URL. */
export default function AvatarCrop({
  src,
  onCancel,
  onDone,
}: {
  src: string;
  onCancel: () => void;
  onDone: (dataUrl: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const BOX = 300;

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setNatural({ w: img.width, h: img.height });
      setOffset({ x: 0, y: 0 });
      setZoom(1);
    };
    img.onerror = () => setError('Could not read that image.');
    img.src = src;
  }, [src]);

  // Base scale: cover the crop box at zoom 1.
  const base = natural.w > 0 ? Math.max(BOX / natural.w, BOX / natural.h) : 1;
  const scale = base * zoom;
  const dw = natural.w * scale;
  const dh = natural.h * scale;
  // Clamp so the box stays covered.
  const clampX = Math.max(0, (dw - BOX) / 2);
  const clampY = Math.max(0, (dh - BOX) / 2);
  const cx = Math.min(clampX, Math.max(-clampX, offset.x));
  const cy = Math.min(clampY, Math.max(-clampY, offset.y));

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('Could not read that image.'));
        im.src = src;
      });
      // Crop box in source pixels: box center offset by -c, scaled down.
      const sx = (img.width - BOX / scale) / 2 - cx / scale;
      const sy = (img.height - BOX / scale) / 2 - cy / scale;
      const side = BOX / scale;
      const out = document.createElement('canvas');
      out.width = 256;
      out.height = 256;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable.');
      ctx.drawImage(img, sx, sy, side, side, 0, 0, 256, 256);
      onDone(out.toDataURL('image/jpeg', 0.9));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Crop failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="glass-l2 edge-shimmer w-full max-w-sm rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold">Crop profile picture</h3>
          <button
            type="button"
            onClick={onCancel}
            className="font-mono text-[11px] text-ink-faint hover:text-white"
          >
            Cancel
          </button>
        </div>
        <div
          ref={boxRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative mx-auto mt-3 h-[300px] w-[300px] cursor-grab touch-none select-none overflow-hidden rounded-lg border border-white/10 bg-obsidian-lowest active:cursor-grabbing"
        >
          {natural.w > 0 && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
              style={{
                width: dw,
                height: dh,
                transform: `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`,
              }}
            />
          )}
          {/* crop guides */}
          <div className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-inset ring-primary/60" />
          <div className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-white/10" />
          <div className="pointer-events-none absolute left-0 top-1/2 h-px w-full bg-white/10" />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-ink-faint">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full accent-[#6366f1]"
          />
          <span className="w-10 text-right font-mono text-[11px] text-ink-muted">{zoom.toFixed(1)}×</span>
        </div>
        <p className="mt-1 font-mono text-[10px] text-ink-faint">Drag to pan · square crop · saved at 256px</p>
        {error && <p className="mt-2 font-mono text-[11px] text-[#f87171]">{error}</p>}
        <button
          type="button"
          disabled={busy || natural.w === 0}
          onClick={() => void apply()}
          className="mt-3 w-full rounded-lg bg-primary/25 py-2 font-mono text-xs font-semibold text-white ring-1 ring-inset ring-primary/50 hover:bg-primary/35 disabled:opacity-50"
        >
          {busy ? 'Cropping…' : 'Use this crop'}
        </button>
      </div>
    </div>
  );
}
