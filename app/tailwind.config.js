/** @type {import('tailwindcss').Config} */
// Core surfaces/accents resolve through CSS vars (see index.css :root and
// .theme-* blocks) so a named theme from lib/themes.ts recolors every
// opacity variant (bg-primary/15, border-primary/40, …) automatically.
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: {
          bg: v('bg'),
          lowest: v('bg-lowest'),
          low: v('bg-low'),
          DEFAULT: v('obsidian'),
          high: v('bg-high'),
          highest: v('bg-highest'),
          bright: '#353943',
        },
        ink: {
          DEFAULT: v('ink'),
          muted: v('ink-muted'),
          faint: v('ink-faint'),
        },
        primary: {
          DEFAULT: v('primary'),
          light: '#818cf8',
          pale: '#c0c1ff',
          container: '#8083ff',
        },
        secondary: { DEFAULT: v('secondary'), pale: '#4cd7f6' },
        tertiary: { DEFAULT: v('tertiary'), pale: '#d0bcff' },
        status: { active: '#10b981', warning: '#f59e0b', alert: '#ef4444' },
        badge: {
          flux: '#ec4899',
          sdxl: '#06b6d4',
          lora: '#8b5cf6',
          checkpoint: '#6366f1',
        },
      },
      fontFamily: {
        display: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}

