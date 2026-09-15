export interface CivitaiImage {
  url: string;
  nsfw: boolean | string;
  width: number | null;
  height: number | null;
}

export interface CivitaiVersion {
  id: number;
  name: string;
  baseModel: string;
  downloadUrl: string;
  filesizeKB: number | null;
  images: CivitaiImage[];
  /** Present on by-hash lookups. */
  model?: { name: string; type: string };
}

export interface CivitaiModel {
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  creator: { username: string | null } | null;
  stats: {
    downloadCount: number;
    ratingCount: number;
    rating: number;
  } | null;
  modelVersions: CivitaiVersion[];
}

export interface CivitaiPage {
  items: CivitaiModel[];
  totalItems: number;
  currentPage: number;
  pageSize: number;
  totalPages: number;
  nextCursor: number | null;
}

export const BASE_MODELS = ['Flux.1', 'SDXL', 'Pony', 'SD 1.5', 'Wan 2.1'] as const;

export const MODEL_TYPES = [
  'Checkpoint',
  'LORA',
  'LoCon',
  'TextualInversion',
  'Controlnet',
  'VAE',
  'Poses',
] as const;

export const SORTS = [
  'Highest Rated',
  'Most Downloaded',
  'Newest',
  'Most Liked',
] as const;

export interface ExplorerQuery {
  q: string;
  type: string; // 'All' | MODEL_TYPES member
  baseModel: string; // 'All' | BASE_MODELS member
  sort: (typeof SORTS)[number];
  page: number;
  nsfw: boolean;
}

/** In dev, calls go through the Vite proxy (see vite.config.ts) because the
    Civitai preflight rejects browser Authorization headers. Prod builds will
    use the backend proxy at /api — same path shape. */
const API = import.meta.env.DEV ? '/civitai/api/v1/models' : 'https://civitai.com/api/v1/models';
const API_ROOT = import.meta.env.DEV ? '/civitai/api/v1' : 'https://civitai.com/api/v1';

/** Mirrors OldCode api._get_headers: bearer token when the user saved one. */
function authHeaders(signal?: AbortSignal): { headers: Record<string, string>; signal?: AbortSignal } {
  let key = '';
  try {
    key = localStorage.getItem('sdcodex.apiKey.v1') ?? '';
  } catch {
    /* private mode — anonymous */
  }
  return {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal,
  };
}

export async function fetchModels(query: ExplorerQuery, signal?: AbortSignal): Promise<CivitaiPage> {  const params = new URLSearchParams({
    limit: '24',
    page: String(query.page),
    sort: query.sort,
    period: 'AllTime',
    nsfw: String(query.nsfw),
  });
  if (query.q.trim()) params.set('query', query.q.trim());
  if (query.type !== 'All') params.set('types', query.type);
  if (query.baseModel !== 'All') params.set('baseModels', query.baseModel);

  const res = await fetch(`${API}?${params}`, authHeaders(signal));
  if (!res.ok) throw new Error(`Civitai API ${res.status}`);
  const json = await res.json();
  return {
    items: json.items ?? [],
    totalItems: json.metadata?.totalItems ?? 0,
    currentPage: json.metadata?.currentPage ?? query.page,
    pageSize: json.metadata?.pageSize ?? 24,
    totalPages: json.metadata?.totalPages ?? 1,
    nextCursor: null,
  };
}

/** Validate an API key — mirrors OldCode api.get_user. GET /me returns the
    account (401 anonymous, 403 bad key). */
export interface CivitaiMe {
  username?: string;
  id?: number;
}

export async function fetchMe(apiKey: string, signal?: AbortSignal): Promise<CivitaiMe> {
  const res = await fetch(`${API_ROOT}/me`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Key rejected (unauthorized)');
  }
  if (!res.ok) throw new Error(`Civitai API ${res.status}`);
  return res.json();
}
/** Single model detail — mirrors OldCode api.get_model(model_id). */
export async function fetchModel(modelId: number, signal?: AbortSignal): Promise<CivitaiModel> {
  const res = await fetch(`${API}/${modelId}`, authHeaders(signal));
  if (!res.ok) throw new Error(`Civitai API ${res.status}`);
  return res.json();
}

/** Identify a local file by SHA256 — mirrors api.get_model_version_by_hash. */
export async function fetchVersionByHash(
  hash: string,
  signal?: AbortSignal,
): Promise<CivitaiVersion> {
  const res = await fetch(`${API}/model-versions/by-hash/${hash}`, authHeaders(signal));
  if (!res.ok) throw new Error(`Civitai API ${res.status}`);
  return res.json();
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Local target dir convention per model type, mirroring the prototype. */
export function targetDir(type: string, baseModel: string): string {
  const slug = baseModel.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const folder =
    type === 'Checkpoint'
      ? 'checkpoints'
      : type === 'LORA' || type === 'LoCon'
        ? 'lora'
        : type === 'VAE'
          ? 'vae'
          : type === 'Controlnet'
            ? 'controlnet'
            : 'misc';
  return `/models/${folder}/${slug}/`;
}
