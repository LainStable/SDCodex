/** Plugin manifests mix Material names, Font Awesome classes, and glyphs.
    Render icons as SVG so they do not depend on a separately loaded icon font. */

const ICON_ALIASES: Record<string, string> = {
  'fa-solid fa-angles-left': 'chevrons-left',
  'fa-solid fa-angles-right': 'chevrons-right',
  'fa-solid fa-house': 'home',
  'fa-solid fa-compass': 'explore',
  'fa-solid fa-folder-open': 'folder',
  'fa-solid fa-download': 'download',
  'fa-solid fa-gear': 'settings',
  'fa-solid fa-thumbtack': 'pin',
  'fa-solid fa-cubes': 'cubes',
  'fas fa-tags': 'tag',
  'fas fa-headphones-alt': 'headphones',
  'fas fa-download': 'download',
  'fas fa-images': 'images',
  'fas fa-desktop': 'computer',
  'fas fa-key': 'key',
  'fas fa-list-alt': 'list',
  'fas fa-cog': 'settings',
  'fas fa-calendar-alt': 'calendar',
  'fas fa-history': 'history',
  'fas fa-tasks': 'tasks',
  'fas fa-puzzle-piece': 'puzzle',
  'fas fa-sliders-h': 'sliders',
  'fas fa-compass': 'explore',
  'fas fa-folder': 'folder',
  'fas fa-cubes': 'cubes',
  // Material symbol names shipped by plugin manifests.
  photo_library: 'images',
  auto_fix_high: 'wand',
  drive_file_rename_outline: 'rename',
  subtitles: 'captions',
  // Glyph icons from manifests and the radial menu. Mapping them keeps every
  // icon an inline SVG: a bare glyph falls back to a colour emoji font, which
  // paints its own dark box behind the symbol.
  '☀': 'sun',
  '☾': 'moon',
  '⌂': 'home',
  '⚙': 'settings',
  '→': 'arrow-right',
  '⤓': 'download',
  '☰': 'list',
  '▣': 'images',
  '⚿': 'key',
  '≡': 'list',
};

const ICON_PATHS: Record<string, string[]> = {
  'chevrons-left': ['m15 18-6-6 6-6', 'm9 18-6-6 6-6'],
  'chevrons-right': ['m9 18 6-6-6-6', 'm15 18 6-6-6-6'],
  home: ['m3 10 9-7 9 7', 'M5 9v11h14V9', 'M9 20v-7h6v7'],
  explore: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'm16.2 7.8-2.8 6.4-5.6 2 2.8-6.4 5.6-2Z'],
  folder: ['M3 6h7l2 2h9v11H3z', 'M3 8h18'],
  cloud: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 20h16'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 2.9-.2-.1a1.7 1.7 0 0 0-1.8-.1 1.7 1.7 0 0 0-1 1.5v.2h-3.4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.1l-.2.1L7 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5.7v-3.4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L7 7.6l1.7-2.9.2.1a1.7 1.7 0 0 0 1.8.1 1.7 1.7 0 0 0 1-1.5v-.2h3.4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.1l.2-.1 1.7 2.9-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1Z'],
  cubes: ['m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'm4.3 7.7 7.7 4.4 7.7-4.4', 'M12 12v9', 'M8 5.2l8 4.5v4.5'],
  tag: ['m20.6 13.4-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7.6a2 2 0 0 1 1.4.6l6.8 6.8a2 2 0 0 1 0 3Z', 'M7.5 7.5h.01'],
  headphones: ['M3 14v-3a9 9 0 0 1 18 0v3', 'M5 14h2v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z', 'M19 14h-2v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2Z'],
  images: ['M3 3h14v14H3z', 'M7 21h14V7', 'm5 14 3-3 3 3 2-2 4 4'],
  computer: ['M3 4h18v13H3z', 'M8 21h8', 'M12 17v4'],
  key: ['M21 2l-2 2', 'M8.5 14a5.5 5.5 0 1 1 3.9-1.6L21 21', 'm15 15 2-2', 'm18 18 2-2'],
  list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z'],
  history: ['M3 12a9 9 0 1 0 2.6-6.4L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  tasks: ['M9 11l2 2 4-4', 'M9 5h11', 'M9 12h11', 'M9 19h11', 'M4 5h.01', 'M4 12h.01', 'M4 19h.01'],
  puzzle: ['M19 13h-2a2 2 0 1 0-4 0h-2v8h8v-2a2 2 0 1 0 0-4v-2Z', 'M3 3h8v2a2 2 0 1 0 4 0V3h6v8h-2a2 2 0 1 0-4 0h-2'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M2 14h4', 'M10 8h4', 'M18 16h4'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'm4.9 19.1 1.4-1.4', 'm17.7 6.3 1.4-1.4'],
  moon: ['M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z'],
  'arrow-right': ['M4 12h15', 'm14 6 6 6-6 6'],
  wand: ['M3 21 12 12', 'm15 3 1.3 2.7 2.7 1.3-2.7 1.3L15 11l-1.3-2.7L11 7l2.7-1.3L15 3Z', 'm7 14 .7 1.5L9 16.2l-1.3.7L7 18.4l-.7-1.5L5 16.2l1.3-.7L7 14Z'],
  rename: ['M4 20h16', 'm14.4 5.6 4 4', 'M13 7 5 15v4h4l8-8-4-4Z'],
  captions: ['M3 5h18v14H3z', 'M7 12h3', 'M14 12h3'],
  pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],
};

export function FanIcon({
  icon,
  name,
  className,
}: {
  icon?: string;
  name: string;
  className?: string;
}) {
  const raw = (icon ?? '').trim();
  // Aliases first: a one-character glyph may still have an SVG equivalent,
  // and only an unmapped glyph should fall back to its own font rendering.
  const mapped = ICON_ALIASES[raw] ?? raw.replaceAll('_', '-');
  const paths = ICON_PATHS[mapped];
  if (paths) {
    return (
      <svg
        className={`fan-glyph ${className ?? ''}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths.map((d) => <path key={d} d={d} />)}
      </svg>
    );
  }
  if ([...raw].length === 1) return <span className={className}>{raw}</span>;
  return <span className={className}>{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}
