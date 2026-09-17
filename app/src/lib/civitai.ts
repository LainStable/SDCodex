export interface CivitaiImageMeta {
  prompt?: string;
  negativePrompt?: string;
  [key: string]: unknown;
}

export interface CivitaiImage {
  url: string;
  nsfw: boolean | string;
  width: number | null;
  height: number | null;
  meta?: CivitaiImageMeta | null;
}

export interface CivitaiFile {
  name: string;
  sizeKB: number | null;
  type: string;
  primary: boolean;
  downloadUrl: string;
  hashes: { SHA256?: string; BLAKE3?: string; [k: string]: string | undefined };
}

export interface CivitaiVersion {
  id: number;
  /** Present on by-hash lookups; absent on embedded modelVersions (use parent model id). */
  modelId?: number;
  name: string;
  baseModel: string;
  publishedAt?: string;
  downloadUrl: string;
  filesizeKB: number | null;
  files?: CivitaiFile[];
  images: CivitaiImage[];
  /** Present on by-hash lookups. */
  model?: { name: string; type: string };
}

export interface CivitaiModel {
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  tags?: string[];
  description?: string | null;
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

/** Model types exactly as the reference type list. */
export const MODEL_TYPES = [
  'Checkpoint',
  'Controlnet',
  'DoRA',
  'Hypernetwork',
  'LoCon',
  'LORA',
  'TextualInversion',
  'Upscaler',
  'VAE',
  'Workflows',
] as const;

/** Full Civitai base-model list, exactly as the reference filter cloud. */
export const BASE_MODELS = [
  'ACE Audio', 'Anima', 'AuraFlow', 'Boogu',
  'Chroma', 'CogVideoX', 'Ernie',
  'Flux 3 Video', 'Flux.1 D', 'Flux.1 Kontext',
  'Flux.1 Krea', 'Flux.1 S', 'Flux.2 D',
  'Flux.2 Klein 4B', 'Flux.2 Klein 4B-base',
  'Flux.2 Klein 9B', 'Flux.2 Klein 9B-base',
  'Grok', 'HappyHorse', 'HiDream',
  'HiDream-O1', 'Hunyuan 1',
  'Hunyuan Video', 'Ideogram 4.0', 'Illustrious',
  'Kolors', 'Krea 2', 'Lens', 'LTXV',
  'LTXV 2.3', 'LTXV 2.5', 'LTXV2', 'Lumina',
  'MageFlow', 'MAI', 'MiniMax H3',
  'MiniMax Music 3', 'Mochi', 'Muse Image',
  'NoobAI', 'Other', 'PixArt a', 'PixArt E',
  'Pony', 'Pony V7', 'Qwen', 'Qwen 2',
  'Qwen 3', 'Reve', 'SD 1.4', 'SD 1.5',
  'SD 1.5 Hyper', 'SD 1.5 LCM', 'SD 2.0',
  'SD 2.1', 'SDXL 1.0', 'SDXL Hyper',
  'SDXL Lightning', 'Upscaler',
  'Wan Image 2.7', 'Wan Video 1.3B t2v',
  'Wan Video 14B i2v 480p',
  'Wan Video 14B i2v 720p',
  'Wan Video 14B t2v',
  'Wan Video 2.2 I2V-A14B',
  'Wan Video 2.2 T2V-A14B',
  'Wan Video 2.2 TI2V-5B', 'Wan Video 2.5 I2V',
  'Wan Video 2.5 T2V', 'Wan Video 2.7',
  'Wan Video 3.0', 'ZImageBase',
  'ZImageTurbo',
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
  baseModels: string[]; // empty = all
  sort: (typeof SORTS)[number];
  page: number;
  nsfw: boolean;
}

/** In dev, calls go through Vite proxies (see vite.config.ts) because the
    Civitai preflight rejects browser Authorization headers. Prod builds will
    use the backend proxy at /api — same path shape. */
function mirrorHost(): string {
  try {
    return localStorage.getItem('sdcodex.apiMirror.v1') === 'civitai.red'
      ? 'civitai.red'
      : 'civitai.com';
  } catch {
    return 'civitai.com';
  }
}

function apiBase(): string {
  if (import.meta.env.DEV) {
    return mirrorHost() === 'civitai.red' ? '/civitai-red/api/v1/models' : '/civitai/api/v1/models';
  }
  return `https://${mirrorHost()}/api/v1/models`;
}

function apiRoot(): string {
  if (import.meta.env.DEV) {
    return mirrorHost() === 'civitai.red' ? '/civitai-red/api/v1' : '/civitai/api/v1';
  }
  return `https://${mirrorHost()}/api/v1`;
}

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
  for (const b of query.baseModels) params.append('baseModels', b);

  const res = await fetch(`${apiBase()}?${params}`, authHeaders(signal));
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
  const res = await fetch(`${apiRoot()}/me`, {
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
  const res = await fetch(`${apiBase()}/${modelId}`, authHeaders(signal));
  if (!res.ok) throw new Error(`Civitai API ${res.status}`);
  return res.json();
}

/** Identify a local file by SHA256 — mirrors api.get_model_version_by_hash. */
export async function fetchVersionByHash(
  hash: string,
  signal?: AbortSignal,
): Promise<CivitaiVersion> {
  const res = await fetch(`${apiBase()}/model-versions/by-hash/${hash}`, authHeaders(signal));
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
