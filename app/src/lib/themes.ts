// Named UI themes from themes.md (repo root).
// A user always has one of these selected; there is no "system default" mode.

export interface ThemeDef {
  name: string;
  slug: string;
  mode: 'dark' | 'light';
  blurb: string;
  vars: Record<string, string>;
  fontDisplay: string;
  fontBody: string;
}

const V = (
  bg: string,
  bgLowest: string,
  bgLow: string,
  obsidian: string,
  bgHigh: string,
  bgHighest: string,
  ink: string,
  inkMuted: string,
  inkFaint: string,
  primary: string,
  secondary: string,
  tertiary: string,
): Record<string, string> => ({
  '--c-bg': bg,
  '--c-bg-lowest': bgLowest,
  '--c-bg-low': bgLow,
  '--c-obsidian': obsidian,
  '--c-bg-high': bgHigh,
  '--c-bg-highest': bgHighest,
  '--c-ink': ink,
  '--c-ink-muted': inkMuted,
  '--c-ink-faint': inkFaint,
  '--c-primary': primary,
  '--c-secondary': secondary,
  '--c-tertiary': tertiary,
});

export const THEMES: ThemeDef[] = [
  {
    name: 'Obsidian Codex',
    slug: 'obsidian-codex',
    mode: 'dark',
    blurb: 'Default workstation theme. Deep obsidian surfaces, indigo accents.',
    vars: V(
      '15 19 28', '10 14 23', '24 27 37', '28 31 41', '38 42 52', '49 53 63',
      '223 226 239', '199 196 215', '144 143 160',
      '99 102 241', '6 182 212', '139 92 246',
    ),
    fontDisplay: "Geist, Inter, system-ui, sans-serif",
    fontBody: "Inter, system-ui, sans-serif",
  },
  {
    name: 'Glacier',
    slug: 'glacier',
    mode: 'dark',
    blurb: 'Frozen light. Layered navy glass, ice-blue accents.',
    vars: V(
      '10 14 26', '8 11 22', '15 21 36', '18 25 42', '22 30 50', '30 40 66',
      '225 235 245', '170 185 205', '120 135 155',
      '125 211 252', '200 160 240', '125 211 252',
    ),
    fontDisplay: "Inter, system-ui, sans-serif",
    fontBody: "Inter, system-ui, sans-serif",
  },
  {
    name: 'Carbon',
    slug: 'carbon',
    mode: 'light',
    blurb: 'Enterprise clarity. White surfaces, IBM blue actions.',
    vars: V(
      '255 255 255', '244 244 244', '240 240 240', '232 232 232', '224 224 224', '200 200 200',
      '22 22 22', '60 60 60', '110 110 110',
      '15 98 254', '15 98 254', '25 128 56',
    ),
    fontDisplay: "'IBM Plex Sans', Inter, system-ui, sans-serif",
    fontBody: "'IBM Plex Sans', Inter, system-ui, sans-serif",
  },
  {
    name: 'Silk',
    slug: 'silk',
    mode: 'light',
    blurb: 'Soft neomorphic clay. Cool gray surfaces, indigo focus.',
    vars: V(
      '232 234 240', '222 224 232', '232 234 240', '228 230 237', '242 243 247', '255 255 255',
      '40 45 60', '90 95 115', '140 145 165',
      '99 102 241', '124 58 237', '124 58 237',
    ),
    fontDisplay: "'Plus Jakarta Sans', Inter, system-ui, sans-serif",
    fontBody: "'Plus Jakarta Sans', Inter, system-ui, sans-serif",
  },
  {
    name: 'Obsidian High-Contrast',
    slug: 'obsidian-high-contrast',
    mode: 'dark',
    blurb: 'Precision in darkness. Near-black zinc, violet and emerald.',
    vars: V(
      '9 9 11', '12 12 15', '18 18 22', '20 20 24', '30 30 36', '39 39 42',
      '250 250 250', '161 161 170', '110 110 120',
      '167 139 250', '52 211 153', '52 211 153',
    ),
    fontDisplay: "Geist, Inter, system-ui, sans-serif",
    fontBody: "Geist, Inter, system-ui, sans-serif",
  },
  {
    name: 'Candy',
    slug: 'candy',
    mode: 'light',
    blurb: 'Joyful pop. Hot pink actions on a warm pink-white canvas.',
    vars: V(
      '254 247 255', '255 255 255', '253 240 252', '250 232 248', '250 228 246', '244 214 240',
      '60 20 50', '130 80 120', '180 140 175',
      '224 64 160', '124 82 170', '0 150 204',
    ),
    fontDisplay: "'DM Sans', Inter, system-ui, sans-serif",
    fontBody: "'DM Sans', Inter, system-ui, sans-serif",
  },
  {
    name: 'Alexandria',
    slug: 'alexandria',
    mode: 'light',
    blurb: 'Digital curator. Serif headlines, archival tones, whitespace structure.',
    vars: V(
      '250 249 246', '244 242 236', '250 249 246', '240 238 231', '236 233 224', '228 224 214',
      '25 25 30', '80 78 85', '140 138 145',
      '9 76 178', '109 94 0', '109 94 0',
    ),
    fontDisplay: "'Noto Serif', Georgia, serif",
    fontBody: "Inter, system-ui, sans-serif",
  },
  {
    name: 'Terra',
    slug: 'terra',
    mode: 'light',
    blurb: 'Rooted warmth. Cream surfaces, forest green actions.',
    vars: V(
      '250 246 240', '244 238 230', '250 246 240', '246 241 233', '240 232 220', '232 222 208',
      '46 50 48', '110 105 95', '160 155 145',
      '74 124 89', '112 92 48', '112 92 48',
    ),
    fontDisplay: "Literata, Georgia, serif",
    fontBody: "'Nunito Sans', Inter, system-ui, sans-serif",
  },
];

export const THEME_STORAGE_KEY = 'sdcodex.theme.md.v1';
export const THEME_CHANGED_EVENT = 'sdcodex:theme-changed';
/** Every account starts on Obsidian Codex unless it picked something else. */
export const DEFAULT_THEME_SLUG = 'obsidian-codex';

export function isThemeSlug(slug: string): boolean {
  return THEMES.some((t) => t.slug === slug);
}

/** Active named-theme slug. Falls back to the default theme, never ''. */
export function loadTheme(): string {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY) || '';
    return isThemeSlug(v) ? v : DEFAULT_THEME_SLUG;
  } catch {
    return DEFAULT_THEME_SLUG;
  }
}

export const THEME_PAYLOAD_KEY = 'sdcodex.theme.payload.v1';

/** Serialised palette for consumers outside the React tree (plugin iframes). */
export function themePayload(slug: string) {
  const t = THEMES.find((x) => x.slug === slug) ?? THEMES[0];
  return {
    slug: t.slug,
    mode: t.mode,
    vars: t.vars,
    fontDisplay: t.fontDisplay,
    fontBody: t.fontBody,
  };
}

/** Mirror the resolved palette into localStorage so a plugin page can paint
    itself before its parent posts anything. */
export function saveThemePayload(slug: string): void {
  try {
    localStorage.setItem(THEME_PAYLOAD_KEY, JSON.stringify(themePayload(slug)));
  } catch {
    /* ignore */
  }
}

export function saveTheme(slug: string): void {
  const value = isThemeSlug(slug) ? slug : DEFAULT_THEME_SLUG;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
}

export function themeClass(slug: string): string {
  return `theme-${isThemeSlug(slug) ? slug : DEFAULT_THEME_SLUG}`;
}
