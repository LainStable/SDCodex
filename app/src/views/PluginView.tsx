import type { InstalledPlugin } from '../lib/plugins';

/** A plugin space: sidebar swaps to the plugin's nav, main area embeds the
    plugin's Stitch-styled static page from the backend. */
export default function PluginView({
  plugin,
  page,
}: {
  plugin: InstalledPlugin;
  page: string | null;
}) {
  const current = page ?? plugin.nav_items[0]?.page ?? '';
  return (
    <div>
      <iframe
        key={`${plugin.id}/${current}`}
        title={`${plugin.name} — ${current}`}
        src={`/api/plugins/${plugin.id}/page/${current}`}
        className="h-[calc(100vh-140px)] min-h-[480px] w-full rounded-lg border border-white/[0.06] bg-obsidian-lowest"
      />
    </div>
  );
}
