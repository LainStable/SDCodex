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

export async function fetchCatalog(): Promise<{ catalog: HubCatalog; live: boolean }> {
  try {
    const { apiGet, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) throw new Error('Backend unreachable');
    const json = await apiGet<HubCatalog>('/plugins/store');
    if (!Array.isArray(json.plugins)) throw new Error('bad catalog');
    return { catalog: json, live: true };
  } catch {
    return { catalog: { name: 'SDCodex Plugin Hub', description: '', version: '', plugins: [] }, live: false };
  }
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
  list: InstalledPlugin[];
  /** False while the backend's background remote check is still running. */
  checked: boolean;
}

export async function fetchInstalled(): Promise<InstalledPluginsResult> {
  try {
    const { apiGet, backendAvailable } = await import('./backend');
    if (!(await backendAvailable())) return { list: [], checked: false };
    const r = await apiGet<{ installed?: InstalledPlugin[]; updates_checked?: boolean }>('/plugins');
    return {
      list: Array.isArray(r.installed) ? r.installed : [],
      checked: r.updates_checked !== false,
    };
  } catch {
    return { list: [], checked: false };
  }
}
