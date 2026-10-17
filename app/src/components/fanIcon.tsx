/** Fan-button glyph. Plugin manifests mix three icon vocabularies:
    Material-symbol names ("photo_library"), Font Awesome classes
    ("fas fa-tags", no FA font is bundled), and single unicode glyphs.
    Material names render via the bundled Material Symbols Rounded font;
    FA classes map to their nearest Material equivalent; anything else
    collapses to a single-letter monogram so raw names never leak as
    floating text inside the 44px fan button. */

const FA_TO_MATERIAL: Record<string, string> = {
  'fa-solid fa-angles-left': 'keyboard_double_arrow_left',
  'fa-solid fa-angles-right': 'keyboard_double_arrow_right',
  'fas fa-tags': 'sell',
  'fas fa-headphones-alt': 'headphones',
  'fas fa-download': 'download',
  'fas fa-images': 'photo_library',
  'fas fa-desktop': 'computer',
  'fas fa-key': 'key',
  'fas fa-list-alt': 'list_alt',
  'fas fa-cog': 'settings',
  'fas fa-calendar-alt': 'calendar_month',
  'fas fa-history': 'history',
  'fas fa-tasks': 'task_alt',
  'fas fa-puzzle-piece': 'extension',
  'fas fa-sliders-h': 'tune',
  'fas fa-compass': 'explore',
  'fas fa-folder': 'folder',
  'fas fa-cubes': 'deployed_code',
};

const MATERIAL_RE = /^[a-z0-9]+(_[a-z0-9]+)*$/;

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
  if ([...raw].length === 1) return <span className={className}>{raw}</span>;
  const mapped = FA_TO_MATERIAL[raw] ?? (MATERIAL_RE.test(raw) ? raw : null);
  if (mapped) {
    return (
      <span className={`material-symbols-rounded fan-glyph ${className ?? ''}`} aria-hidden="true">
        {mapped}
      </span>
    );
  }
  return <span className={className}>{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}
