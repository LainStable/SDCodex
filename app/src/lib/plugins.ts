/* Plugin Hub catalog. The hub repo (own git, ignored by core) publishes
   plugins.json; the app reads it for the available-plugin list and compares
   versions to notify about new plugins and updates. */

export const HUB_URL =
  'https://raw.githubusercontent.com/LainStable/SDCodex-Plugin-Hub/main/plugins.json';

export interface HubPlugin {
  id: string;
  name: string;
  description: string;
  repository: string;
  version: string;
}

export interface HubCore {
  id: string;
  name: string;
  description: string;
  repository: string;
  version: string;
}

export interface HubCatalog {
  name: string;
  description: string;
  version: string;
  core?: HubCore;
  plugins: HubPlugin[];
}

const FALLBACK: HubCatalog = {
  name: 'SDCodex Plugin Hub',
  description: 'Built-in list (hub unreachable).',
  version: '0.0.0',
  plugins: [
    {
      id: 'gallery',
      name: 'SDCodex Gallery',
      description: 'Disk-backed media gallery.',
      repository: 'https://github.com/LainStable/SDCodex-Gallery',
      version: '0.0.0',
    },
    {
      id: 'gallery-dl',
      name: 'GalleryDL & Tools',
      description: 'Background gallery-dl and yt-dlp tasks.',
      repository: 'https://github.com/LainStable/SDCodex-GalleryDL',
      version: '0.0.0',
    },
    {
      id: 'rembg',
      name: 'RemBG Background Tools',
      description: 'Background removal and batch processing.',
      repository: 'https://github.com/LainStable/SDCodex-RemBG',
      version: '0.0.0',
    },
    {
      id: 'comfy-caption',
      name: 'ComfyUI Captioning',
      description: 'Auto-captioning with vision LLMs.',
      repository: 'https://github.com/LainStable/SDCodex-ComfyCaption',
      version: '0.0.0',
    },
  ],
};

export async function fetchCatalog(signal?: AbortSignal): Promise<{ catalog: HubCatalog; live: boolean }> {
  try {
    const res = await fetch(HUB_URL, { signal });
    if (!res.ok) throw new Error(`hub ${res.status}`);
    const json = (await res.json()) as HubCatalog;
    if (!Array.isArray(json.plugins)) throw new Error('bad catalog');
    return { catalog: json, live: true };
  } catch {
    return { catalog: FALLBACK, live: false };
  }
}
