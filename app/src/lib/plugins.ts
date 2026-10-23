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

export async function fetchCatalog(refresh = false): Promise<{ catalog: HubCatalog; live: boolean }> {
  try {
    const { apiGet, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) throw new Error('Backend unreachable');
    const json = await apiGet<HubCatalog>(`/plugins/store${refresh ? '?refresh=1' : ''}`);
    if (!Array.isArray(json.plugins)) throw new Error('bad catalog');
    return { catalog: json, live: true };
  } catch {
    return { catalog: { name: 'SDCodex Plugin Hub', description: '', version: '', plugins: [] }, live: false };
  }
}

/** Compare dotted versions numerically: `versionAtLeast('2.8.27', '2.8.27')`. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = minimum.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** An installed plugin space: fan icon, sidebar nav, settings tabs. */
export interface PluginNavItem {
  label: string;
  icon?: string;
  page: string;
}

export interface PluginSettingTab {
  label: string;
  page: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  entry_page?: string;
  nav_items: PluginNavItem[];
  settings: PluginSettingTab[];
  has_update?: boolean;
}

export interface InstalledPluginsResult {
  /** Null means the request failed — callers must keep their previous list. */
  list: InstalledPlugin[] | null;
  /** False while the backend's background remote check is still running. */
  checked: boolean;
}

export async function fetchInstalled(): Promise<InstalledPluginsResult> {
  try {
    const { apiGet, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) return { list: null, checked: false };
    const r = await apiGet<{ installed?: InstalledPlugin[]; updates_checked?: boolean }>('/plugins');
    return {
      list: Array.isArray(r.installed) ? r.installed : [],
      checked: r.updates_checked !== false,
    };
  } catch {
    // A transient failure (restart, queue saturation, Cloudflare 524) must not
    // render as "no plugins installed"; keep the caller's previous list.
    return { list: null, checked: false };
  }
}
