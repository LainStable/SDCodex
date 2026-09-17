/* Folder categories (Settings dirs) vs Civitai model types use different
   taxonomies: the Embedding folder holds TextualInversion models, etc.
   This map normalizes API types to their folder category for grouping. */

const API_TO_FOLDER: Record<string, string> = {
  Checkpoint: 'Checkpoint',
  TextualInversion: 'Embedding',
  Hypernetwork: 'Hypernetwork',
  AestheticGradient: 'AestheticGradient',
  LORA: 'LORA',
  LoCon: 'LyCORIS',
  DoRA: 'DoRA',
  Controlnet: 'Controlnet',
  Upscaler: 'Upscaler',
  MotionModule: 'Motion',
  VAE: 'VAE',
  Poses: 'Poses',
  Wildcards: 'Wildcards',
  Workflows: 'Workflows',
  Detection: 'Detection',
  Other: 'Other',
};

export function folderForModelType(apiType: string): string {
  return API_TO_FOLDER[apiType] ?? 'Other';
}
