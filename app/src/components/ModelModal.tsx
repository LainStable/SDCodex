/* Floating model detail modal (zoom-out open). Shows everything the reference
   viewer shows: tags, version pills, image gallery, details table, files with
   hashes, description, and embedded generation data when present. */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchModel,
  fetchModels,
  formatCount,
  type CivitaiImage,
  type CivitaiModel,
} from '../lib/civitai';
import { DangerButton, GhostButton, PrimaryButton } from '../components/chrome';
import { Stars, TypeBadge } from '../components/ui';

export type ModalTarget =
  | { kind: 'civitai'; modelId: number }
  | {
      kind: 'local';
      title: string;
      type: string;
      hash?: string;
      size?: string;
      path?: string;
      params?: string;
      modelId?: number;
      versionId?: number;
      /** Set for scanned library records — enables record Delete. */
      record?: { modelId: number; versionId: number };
      /** Server library row id — enables Update-metadata write-back. */
      rowId?: number;
    };

interface QueueArg {
  id: string;
  name: string;
  detail: string;
  downloadUrl: string;
  modelId: number;
  versionId: number;
  baseModel: string;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|p|li|h[1-6]|div)[^>]*>/gi, '\n')
    .replace(/<\/[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shortHash(h?: string): string {
  if (!h) return '—';
  return h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function formatSize(kb: number | null | undefined): string {
  if (kb == null) return '—';
  const gb = kb / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** Parse PNG tEXt/iTXt chunks for embedded prompt/workflow (ComfyUI, Auto1111). */
function parsePngText(buf: ArrayBuffer): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (dv.getUint8(i) !== sig[i]) return out;
  let off = 8;
  const dec = new TextDecoder('utf-8');
  const latin = new TextDecoder('latin1');
  while (off + 8 <= dv.byteLength) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
    const data = new Uint8Array(buf, off + 8, Math.min(len, dv.byteLength - off - 8));
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        out[latin.decode(data.slice(0, nul))] = latin.decode(data.slice(nul + 1));
      }
    } else if (type === 'iTXt') {
      let p = 0;
      while (p < data.length && data[p] !== 0) p++;
      const keyword = dec.decode(data.slice(0, p));
      // layout: keyword\0 compFlag(1) compMethod(1) lang\0 translated\0 text
      let q = p + 3;
      while (q < data.length && data[q] !== 0) q++;
      q++;
      while (q < data.length && data[q] !== 0) q++;
      q++;
      const compressed = data[p + 1] === 1;
      if (!compressed) {
        try {
          out[keyword] = dec.decode(data.slice(q));
        } catch {
          /* skip */
        }
      }
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
    if (off > 8 * 1024 * 1024) break; // only metadata head matters
  }
  return out;
}

export interface AdoptedMatch {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  baseModel: string;
}

/** Write a user-confirmed match back to whichever store owns the row. */
export async function adoptMatch(
  t: Extract<ModalTarget, { kind: 'local' }>,
  m: AdoptedMatch,
  onLibraryChanged: () => void,
): Promise<void> {
  if (t.rowId != null) {
    const { apiPost, backendAvailable } = await import('../lib/backend');
    if (!(await backendAvailable())) throw new Error('Backend unreachable');
    await apiPost(`/library/${t.rowId}/identify`, {
      modelId: m.modelId,
      versionId: m.versionId,
    });
  } else if (t.record) {
    const { adoptScannedMatch } = await import('../lib/library');
    adoptScannedMatch(t.record.modelId, t.record.versionId, m);
  }
  onLibraryChanged();
}

function UpdateMetadata({
  defaultQuery,
  onAdopt,
}: {
  defaultQuery: string;
  onAdopt: (m: AdoptedMatch) => Promise<void>;
}) {
  const [q, setQ] = useState(defaultQuery);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cands, setCands] = useState<CivitaiModel[]>([]);
  const [searched, setSearched] = useState(false);
  const [adopting, setAdopting] = useState<number | null>(null);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const page = await fetchModels(
        { q: q.trim(), type: 'All', baseModels: [], sort: 'Most Downloaded', page: 1, nsfw: false },
      );
      setCands(page.items.slice(0, 6));
      setSearched(true);
      if (page.items.length === 0) setError('No Civitai models match that name.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (id: number) => {
    setAdopting(id);
    setError(null);
    try {
      const full = await fetchModel(id);
      const v0 = full.modelVersions[0];
      if (!v0) throw new Error('Model has no versions');
      await onAdopt({
        modelId: full.id,
        versionId: v0.id,
        name: full.name,
        type: full.type,
        baseModel: v0.baseModel,
      });
      setDone(`Matched as ${full.name} — loading details…`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adopt failed');
    } finally {
      setAdopting(null);
    }
  };

  return (
    <div className="glass-l1 mt-3 rounded-lg p-3">
      <h3 className="font-display text-sm font-semibold">Update metadata</h3>
      <p className="mt-1 font-mono text-[10px] text-ink-faint">
        Not hosted on Civitai under its hash? Search by filename and pick the match.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
          placeholder="Model name from filename…"
          className="min-w-0 flex-1 rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary"
        />
        <GhostButton disabled={busy || !q.trim()} onClick={() => void search()}>
          {busy ? 'Searching…' : 'Search Civitai'}
        </GhostButton>
      </div>
      {error && <p className="mt-2 font-mono text-[11px] text-[#f87171]">{error}</p>}
      {done && <p className="mt-2 font-mono text-[11px] text-status-active">{done}</p>}
      {searched && cands.length > 0 && !done && (
        <ul className="mt-2 space-y-1.5">
          {cands.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded border border-white/[0.06] px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{c.name}</div>
                <div className="truncate font-mono text-[10px] text-ink-faint">
                  {c.type} · {c.modelVersions[0]?.baseModel ?? '—'} · @{c.creator?.username ?? '—'}
                </div>
              </div>
              <GhostButton disabled={adopting !== null} onClick={() => void adopt(c.id)}>
                {adopting === c.id ? '…' : 'Select'}
              </GhostButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ModelModal({
  target,
  onClose,
  onQueue,
  queuedIds,
  ownedIds,
  onSearchCreator,
  onForgetLocal,
  onLibraryChanged,
}: {
  target: ModalTarget;
  onClose: () => void;
  onQueue: (item: QueueArg) => void;
  queuedIds: Set<string>;
  ownedIds: Set<string>;
  onSearchCreator: (username: string) => void;
  onForgetLocal?: (modelId: number, versionId: number) => void;
  onLibraryChanged?: () => void;
}) {
  const [model, setModel] = useState<CivitaiModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [imgIdx, setImgIdx] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [embedded, setEmbedded] = useState<Record<string, string> | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const baseModelId = target.kind === 'civitai' ? target.modelId : (target.modelId ?? 0);
  // Adopted via Update-metadata: flips an unknown entry into the full view.
  const [adoptedId, setAdoptedId] = useState<number | null>(null);
  const modelId = adoptedId ?? baseModelId;

  useEffect(() => {
    if (!modelId) return;
    const ctl = new AbortController();
    setModel(null);
    setError(null);
    setVersionId(null);
    setImgIdx(0);
    setEmbedded(null);
    fetchModel(modelId, ctl.signal)
      .then((m) => {
        if (target.kind === 'local' && 'versionId' in target && target.versionId) {
          const v = m.modelVersions.find((x) => x.id === target.versionId);
          setVersionId(v?.id ?? m.modelVersions[0]?.id ?? null);
        } else {
          setVersionId(m.modelVersions[0]?.id ?? null);
        }
        setModel(m);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Request failed');
        }
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightbox) setLightbox(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, onClose]);

  const version = model?.modelVersions.find((v) => v.id === versionId) ?? model?.modelVersions[0];
  const images: CivitaiImage[] = version?.images ?? [];

  // Wheel over the main image cycles through all images (non-passive listener).
  useEffect(() => {
    const el = mainRef.current;
    if (!el || images.length < 2) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setImgIdx((i) => (i + (e.deltaY > 0 ? 1 : images.length - 1)) % images.length);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [images.length]);

  // Embedded generation data: prefer API meta, else parse PNG text chunks.
  useEffect(() => {
    const img = images[imgIdx];
    setEmbedded(null);
    if (!img) return;
    if (img.meta?.prompt || img.meta?.negativePrompt) {
      setEmbedded({
        ...(img.meta.prompt ? { prompt: String(img.meta.prompt) } : {}),
        ...(img.meta.negativePrompt ? { negative: String(img.meta.negativePrompt) } : {}),
      });
      return;
    }
    let live = true;
    (async () => {
      try {
        const res = await fetch(img.url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        if (!live) return;
        const texts = parsePngText(buf);
        const picked: Record<string, string> = {};
        if (texts.parameters) picked.parameters = texts.parameters;
        if (texts.prompt) picked.prompt = texts.prompt;
        if (texts.workflow) picked.workflow = texts.workflow;
        if (Object.keys(picked).length > 0 && live) setEmbedded(picked);
      } catch {
        /* offline or CORS — section stays hidden */
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, imgIdx]);

  const closeLightbox = useCallback(() => setLightbox(false), []);

  // Local-only entries (no Civitai id yet): known fields + metadata matcher.
  if (target.kind === 'local' && !modelId) {
    const t = target;
    return (
      <Overlay onClose={onClose}>
        <div className="glass-l2 modal-pop max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-xl font-semibold">{t.title}</h2>
              <div className="mt-1 flex gap-1.5">
                <TypeBadge type={t.type} />
              </div>
            </div>
            <GhostButton onClick={onClose}>✕</GhostButton>
          </div>
          <dl className="mt-3 space-y-1 font-mono text-[12px] text-ink-muted">
            {t.params && (
              <div className="flex justify-between gap-2"><dt>params</dt><dd className="text-ink">{t.params}</dd></div>
            )}
            {t.hash && (
              <div className="flex justify-between gap-2"><dt>hash</dt><dd>{t.hash}</dd></div>
            )}
            {t.size && (
              <div className="flex justify-between gap-2"><dt>size</dt><dd>{t.size}</dd></div>
            )}
            {t.path && <div className="truncate pt-1 text-ink-faint">{t.path}</div>}
          </dl>
          <UpdateMetadata
            defaultQuery={(t.path?.split('/').pop() ?? t.title).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')}
            onAdopt={async (m) => {
              await adoptMatch(t, m, () => onLibraryChanged?.());
              setAdoptedId(m.modelId);
            }}
          />
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={onClose}>
      <div className="glass-l2 modal-pop noscroll max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg p-4 md:p-5">
        {error && (
          <div className="rounded border border-status-alert/40 bg-status-alert/10 p-4 text-sm">
            <span className="font-semibold text-[#f87171]">Model unavailable:</span> {error}
          </div>
        )}
        {!model && !error && <div className="h-96 animate-pulse rounded-lg bg-white/5" />}
        {model && version && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-display text-xl font-semibold tracking-tight" title={model.name}>
                  {model.name}
                </h2>
                <div className="mt-1 font-mono text-[11px] text-ink-faint">
                  {formatCount(model.stats?.downloadCount ?? 0)} DL ·{' '}
                  {formatCount(model.stats?.ratingCount ?? 0)} ratings
                </div>
              </div>
              <GhostButton onClick={onClose}>✕</GhostButton>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {model.modelVersions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    setVersionId(v.id);
                    setImgIdx(0);
                  }}
                  className={`rounded border px-2.5 py-1 font-mono text-[11px] ${
                    v.id === version.id
                      ? 'border-primary/60 bg-primary/25 text-white'
                      : 'border-white/10 bg-white/5 text-ink-muted hover:border-white/25'
                  }`}
                >
                  {v.name}
                </button>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <div className="flex items-center gap-2">
                  <TypeBadge type={model.type} />
                </div>

                <div ref={mainRef} className="mt-3 flex h-[320px] items-center justify-center overflow-hidden rounded-lg bg-black/40 md:h-[440px]">
                  {images[imgIdx] ? (
                    <img
                      src={images[imgIdx].url}
                      alt=""
                      onClick={() => setLightbox(true)}
                      className="max-h-full max-w-full cursor-zoom-in object-contain"
                      title="Click to expand · scroll to browse images"
                    />
                  ) : (
                    <div className="font-mono text-xs text-ink-faint">no preview</div>
                  )}
                </div>
                {images.length > 1 && (
                  <div className="noscroll mt-2 flex gap-1.5 overflow-x-auto pb-1">
                    {images.map((img, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setImgIdx(i)}
                        className={`h-14 w-14 shrink-0 overflow-hidden rounded border ${
                          i === imgIdx ? 'border-primary/70' : 'border-white/10 opacity-60 hover:opacity-100'
                        }`}
                      >
                        <img src={img.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-1 font-mono text-[10px] text-ink-faint">
                  {images.length > 0 ? `image ${imgIdx + 1}/${images.length} · scroll to browse · click to expand` : ''}
                </div>

                {model.description && (
                  <div className="glass-l1 noscroll mt-3 max-h-56 overflow-y-auto rounded-lg p-3 text-[13px] leading-relaxed text-ink-muted">
                    {htmlToText(model.description).slice(0, 2000)}
                  </div>
                )}

                {embedded && (
                  <div className="glass-l1 mt-3 rounded-lg p-3">
                    <h3 className="font-display text-sm font-semibold">Generation data (embedded)</h3>
                    {embedded.prompt && (
                      <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-muted">
                        {embedded.prompt.slice(0, 1200)}
                      </p>
                    )}
                    {embedded.negative && (
                      <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-faint">
                        negative: {embedded.negative.slice(0, 600)}
                      </p>
                    )}
                    {embedded.parameters && (
                      <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-muted">
                        {embedded.parameters.slice(0, 1200)}
                      </p>
                    )}
                    {embedded.workflow && (
                      <details className="mt-1">
                        <summary className="cursor-pointer font-mono text-[11px] text-secondary">
                          ComfyUI workflow JSON
                        </summary>
                        <pre className="noscroll mt-1 max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] text-ink-muted">
                          {embedded.workflow.slice(0, 4000)}
                        </pre>
                      </details>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-ink-faint">
                      Full workflow tooling arrives with the ComfyCaption plugin.
                    </p>
                  </div>
                )}
              </div>

              <div className="lg:col-span-2">
                <div className="glass-l1 rounded-lg p-3">
                  <h3 className="font-display text-sm font-semibold">Details</h3>
                  <dl className="mt-2 space-y-1.5 font-mono text-[12px]">
                    <div className="flex justify-between gap-2 border-b border-white/[0.06] pb-1.5">
                      <dt className="text-ink-faint">Author</dt>
                      <dd>
                        {model.creator?.username ? (
                          <button
                            type="button"
                            onClick={() => onSearchCreator(model.creator!.username!)}
                            className="text-secondary hover:underline"
                          >
                            @{model.creator.username}
                          </button>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </dd>
                    </div>
                    <DetailRow k="Model Type" v={model.type} />
                    <DetailRow k="Base Model" v={version.baseModel} />
                    <DetailRow
                      k="Hash"
                      v={shortHash(version.files?.find((f) => f.primary)?.hashes.SHA256 ?? version.files?.[0]?.hashes.SHA256)}
                    />
                    <DetailRow k="Last Updated" v={formatDate(version.publishedAt)} />
                    <div className="flex items-center justify-between gap-2 pt-0.5">
                      <dt className="text-ink-faint">Rating</dt>
                      <dd>
                        <Stars rating={model.stats?.rating ?? 0} />
                      </dd>
                    </div>
                  </dl>
                </div>

                {model.tags && model.tags.length > 0 && (
                  <div className="glass-l1 mt-3 rounded-lg p-3">
                    <h3 className="font-display text-sm font-semibold">Tags</h3>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {model.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-ink-muted"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="glass-l1 mt-3 rounded-lg p-3">
                  <h3 className="font-display text-sm font-semibold">Files</h3>
                  {(version.files ?? []).map((f) => {
                    const qid = `civitai-${model.id}-${version.id}-${f.name}`;
                    const queued = queuedIds.has(`civitai-${model.id}-${version.id}`) || queuedIds.has(qid);
                    const owned = ownedIds.has(`${model.id}-${version.id}`);
                    return (
                      <div key={f.name} className="mt-2 border-t border-white/[0.06] pt-2 first:border-0 first:pt-0">
                        <div className="truncate font-mono text-[12px] text-ink" title={f.name}>
                          {f.name}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
                          {f.type} · {formatSize(f.sizeKB)}
                          {f.primary ? ' · primary' : ''}
                        </div>
                        <div className="mt-0.5 space-y-0.5 font-mono text-[10px] text-ink-faint">
                          {f.hashes.SHA256 && <div>SHA256: {shortHash(f.hashes.SHA256)}</div>}
                          {f.hashes.BLAKE3 && <div>BLAKE3: {shortHash(f.hashes.BLAKE3)}</div>}
                        </div>
                        <div className="mt-2 flex gap-1.5">
                          {target.kind !== 'local' && (
                            <PrimaryButton
                              className="!px-3 !py-1 !text-[11px]"
                              disabled={queued || owned}
                              onClick={() =>
                                onQueue({
                                  id: qid,
                                  name: `${model.name} · ${version.name}`,
                                  detail: `${f.name} · ${formatSize(f.sizeKB)}`,
                                  downloadUrl: f.downloadUrl || version.downloadUrl,
                                  modelId: model.id,
                                  versionId: version.id,
                                  baseModel: version.baseModel,
                                })
                              }
                            >
                              {queued ? '✓ Queued' : owned ? '✓ Installed' : '⬇ Download'}
                            </PrimaryButton>
                          )}
                          {target.kind === 'local' && target.record && onForgetLocal && (
                            <DangerButton
                              onClick={() => {
                                onForgetLocal(target.record!.modelId, target.record!.versionId);
                                onClose();
                              }}
                            >
                              Delete
                            </DangerButton>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {(version.files ?? []).length === 0 && (
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">No file list published.</p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {lightbox && images[imgIdx] && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={closeLightbox}
        >
          <div
            className="glass-l2 modal-pop checker max-h-[86vh] max-w-[92vw] overflow-auto rounded-lg p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-ink-faint">
                image {imgIdx + 1}/{images.length}
              </span>
              <button
                type="button"
                onClick={closeLightbox}
                className="rounded border border-white/20 bg-black/60 px-2.5 py-1 font-mono text-xs text-white hover:bg-black/80"
              >
                ✕
              </button>
            </div>
            <img
              src={images[imgIdx].url}
              alt=""
              className="max-h-[70vh] max-w-full rounded object-contain"
            />
          </div>
        </div>
      )}
    </Overlay>
  );
}

function DetailRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-white/[0.06] pb-1.5">
      <dt className="text-ink-faint">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
