export type ModelKind = 'checkpoint' | 'lora' | 'sdxl' | 'flux';
export type SocketState = 'rw' | 'ro' | 'missing';

export interface ModelEntry {
  id: string;
  title: string;
  kind: ModelKind;
  /** Civitai-style model type (filters against the shared type list). */
  type: string;
  /** Civitai base model (filters against the shared base cloud). */
  baseModel: string;
  params: string;
  hash: string;
  size: string;
  path: string;
  socket: SocketState;
}

export const MODELS: ModelEntry[] = [
  {
    id: 'm1',
    title: 'Obsidian XL Base',
    kind: 'sdxl',
    type: 'Checkpoint',
    baseModel: 'SDXL 1.0',
    params: '3.5B',
    hash: 'a91f…c204',
    size: '6.42 GB',
    path: 'models/sdxl/obsidian-xl.safetensors',
    socket: 'rw',
  },
  {
    id: 'm2',
    title: 'Flux Detail LoRA',
    kind: 'lora',
    type: 'LORA',
    baseModel: 'Flux.1 D',
    params: '128M',
    hash: '77b0…9e11',
    size: '512 MB',
    path: 'models/lora/flux-detail.safetensors',
    socket: 'rw',
  },
  {
    id: 'm3',
    title: 'Checkpoint Prime',
    kind: 'checkpoint',
    type: 'Checkpoint',
    baseModel: 'SD 1.5',
    params: '12B',
    hash: 'c3d9…41ab',
    size: '11.8 GB',
    path: 'models/checkpoints/prime.safetensors',
    socket: 'ro',
  },
  {
    id: 'm4',
    title: 'Flux Portrait',
    kind: 'flux',
    type: 'Checkpoint',
    baseModel: 'Flux.1 D',
    params: '12B',
    hash: 'e50a…78cd',
    size: '10.9 GB',
    path: 'models/flux/portrait.safetensors',
    socket: 'rw',
  },
  {
    id: 'm5',
    title: 'SDXL Turbo Mini',
    kind: 'sdxl',
    type: 'Checkpoint',
    baseModel: 'SDXL Lightning',
    params: '2.1B',
    hash: '19fe…b307',
    size: '4.10 GB',
    path: 'models/sdxl/turbo-mini.safetensors',
    socket: 'missing',
  },
  {
    id: 'm6',
    title: 'Style LoRA Pack',
    kind: 'lora',
    type: 'LORA',
    baseModel: 'Pony',
    params: '96M',
    hash: 'ab12…ff90',
    size: '384 MB',
    path: 'models/lora/style-pack.safetensors',
    socket: 'ro',
  },
];
