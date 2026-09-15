import { useEffect, useState } from 'react';
import { fetchModel, formatCount, type CivitaiModel } from '../lib/civitai';
import { targetDirFor } from '../lib/settings';
import { GhostButton, PageHeader, PrimaryButton } from '../components/chrome';
import { Stars, TypeBadge } from '../components/ui';

interface Props {
  modelId: number;
  onBack: () => void;
  onSearchCreator: (username: string) => void;
  onQueue: (item: {
    id: string;
    name: string;
    detail: string;
    downloadUrl: string;
    modelId: number;
    versionId: number;
    baseModel: string;
  }) => void;
  queuedIds: Set<string>;
}

export default function Detail({ modelId, onBack, onSearchCreator, onQueue, queuedIds }: Props) {
  const [model, setModel] = useState<CivitaiModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<number | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setModel(null);
    setError(null);
    setVersionId(null);
    fetchModel(modelId, ctl.signal)
      .then((m) => {
        setModel(m);
        setVersionId(m.modelVersions[0]?.id ?? null);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Request failed');
        }
      });
    return () => ctl.abort();
  }, [modelId]);

  if (error) {
    return (
      <div>
        <GhostButton onClick={onBack}>← Back to Models</GhostButton>
        <div className="glass-l1 mt-4 rounded-lg border-status-alert/40 p-4 text-sm">
          <span className="font-semibold text-[#f87171]">Model unavailable:</span> {error}
        </div>
      </div>
    );
  }

  if (!model) {
    return (
      <div>
        <GhostButton onClick={onBack}>← Back to Models</GhostButton>
        <div className="glass-l1 mt-4 h-64 animate-pulse rounded-lg" />
      </div>
    );
  }

  const version = model.modelVersions.find((v) => v.id === versionId) ?? model.modelVersions[0];
  const queued = queuedIds.has(`civitai-${model.id}-${version?.id}`);

  return (
    <div>
      <GhostButton onClick={onBack}>← Back to Models</GhostButton>
      <div className="mt-3">
        <PageHeader
          title={model.name}
          subtitle={`${model.type} · ${version?.baseModel ?? '—'} · ${model.modelVersions.length} version${model.modelVersions.length === 1 ? '' : 's'}`}
          meta={
            <>
              <Stars rating={model.stats?.rating ?? 0} />
              <span className="ml-2">{formatCount(model.stats?.downloadCount ?? 0)} downloads</span>
              {model.creator?.username && (
                <button
                  type="button"
                  onClick={() => onSearchCreator(model.creator!.username!)}
                  className="ml-2 text-secondary hover:underline"
                >
                  @{model.creator.username}
                </button>
              )}
            </>
          }
          actions={<TypeBadge type={model.type} />}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="glass-l1 overflow-hidden rounded-lg">
          {version?.images[0] ? (
            <img src={version.images[0].url} alt="" className="max-h-[480px] w-full object-cover" />
          ) : (
            <div className="flex h-48 items-center justify-center font-mono text-xs text-ink-faint">
              no preview
            </div>
          )}
        </div>

        <div className="glass-l1 rounded-lg p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Version
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {model.modelVersions.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVersionId(v.id)}
                className={`rounded border px-2.5 py-1 font-mono text-[11px] ${
                  v.id === version?.id
                    ? 'border-primary/50 bg-primary/20 text-white'
                    : 'border-white/10 bg-white/5 text-ink-muted hover:border-white/20'
                }`}
              >
                {v.name}
              </button>
            ))}
          </div>

          {version && (
            <>
              <dl className="mt-3 space-y-1 font-mono text-[11px] text-ink-muted">
                <div className="flex justify-between gap-2">
                  <dt>base</dt>
                  <dd className="text-ink">{version.baseModel}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>size</dt>
                  <dd>
                    {version.filesizeKB != null
                      ? `${(version.filesizeKB / 1024 / 1024).toFixed(2)} GB`
                      : '—'}
                  </dd>
                </div>
                <div className="truncate pt-1 text-ink-faint">
                  {targetDirFor(model.type, version.baseModel)}
                </div>
              </dl>
              <PrimaryButton
                className="mt-3 w-full"
                disabled={queued}
                onClick={() =>
                  onQueue({
                    id: `civitai-${model.id}-${version.id}`,
                    name: `${model.name} · ${version.name}`,
                    detail: `${model.type} · ${version.baseModel}`,
                    downloadUrl: version.downloadUrl,
                    modelId: model.id,
                    versionId: version.id,
                    baseModel: version.baseModel,
                  })
                }
              >
                {queued ? '✓ Queued' : '+ Download queue'}
              </PrimaryButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
