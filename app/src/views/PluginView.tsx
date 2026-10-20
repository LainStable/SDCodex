import { useEffect, useRef } from 'react';
import type { InstalledPlugin } from '../lib/plugins';
import { THEME_CHANGED_EVENT, loadTheme } from '../lib/themes';

/** Read the palette the core currently has applied to <html> so the embedded
    plugin page can mirror it (iframes do not inherit CSS custom properties). */
function readAppTheme() {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const channels = (name: string) => cs.getPropertyValue(name).trim();
  return {
    slug: loadTheme(),
    mode: root.style.colorScheme === 'light' ? 'light' : 'dark',
    vars: {
      bg: channels('--c-bg'),
      card: channels('--c-obsidian'),
      raised: channels('--c-bg-high'),
      ink: channels('--c-ink'),
      inkMuted: channels('--c-ink-muted'),
      inkFaint: channels('--c-ink-faint'),
      primary: channels('--c-primary'),
      secondary: channels('--c-secondary'),
    },
  };
}

/** A plugin space: sidebar swaps to the plugin's nav, main area embeds the
    plugin's Stitch-styled static page from the backend. */
export default function PluginView({
  plugin,
  page,
}: {
  plugin: InstalledPlugin;
  page: string | null;
}) {
  const current = page ?? plugin.nav_items[0]?.page ?? plugin.entry_page ?? '';
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Plugins live in their own document, so the core palette is pushed in via
  // postMessage whenever the frame (re)loads or the user switches themes.
  useEffect(() => {
    const post = () => {
      const frame = frameRef.current;
      frame?.contentWindow?.postMessage(
        { type: 'sdcodex:theme', theme: readAppTheme() },
        window.location.origin,
      );
    };
    // A freshly loaded page asks for the palette as soon as it is ready; the
    // storage mirror usually beats it, but this covers a stale/missing one.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if ((e.data as { type?: string } | null)?.type === 'sdcodex:theme-ready') post();
    };
    post();
    window.addEventListener('message', onMessage);
    window.addEventListener(THEME_CHANGED_EVENT, post);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener(THEME_CHANGED_EVENT, post);
    };
  }, [current, plugin.id]);

  return (
    <div>
      <iframe
        ref={frameRef}
        key={`${plugin.id}/${current}`}
        title={`${plugin.name} — ${current}`}
        src={`/api/plugins/${plugin.id}/page/${current}`}
        onLoad={() => {
          frameRef.current?.contentWindow?.postMessage(
            { type: 'sdcodex:theme', theme: readAppTheme() },
            window.location.origin,
          );
        }}
        className="h-[calc(100dvh-120px)] min-h-[480px] w-full rounded-lg border border-white/[0.06] bg-obsidian-lowest"
      />
    </div>
  );
}
