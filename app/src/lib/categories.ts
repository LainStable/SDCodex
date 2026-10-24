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

/** Folder categories written by the scanner (they are not Civitai API types,
    but must pass through unchanged — otherwise Embedding/LyCORIS/Motion rows
    collapsed into "Other" and their tabs read 0). */
const FOLDER_CATEGORIES = new Set([
  'Checkpoint',
  'Embedding',
  'Hypernetwork',
  'AestheticGradient',
  'LORA',
  'LyCORIS',
  'DoRA',
  'Controlnet',
  'Upscaler',
  'Motion',
  'VAE',
  'Poses',
  'Wildcards',
  'Workflows',
  'Detection',
  'Other',
]);

export function folderForModelType(apiType: string): string {
  if (FOLDER_CATEGORIES.has(apiType)) return apiType;
  return API_TO_FOLDER[apiType] ?? 'Other';
}

/** Accent color for a model type, honoring the folder-category keys the
    Settings picker writes (Checkpoint, Embedding, LORA, …). */
export function accentColor(
  colors: Record<string, string>,
  modelType: string,
): string | undefined {
  return colors[modelType] ?? colors[folderForModelType(modelType)];
}
