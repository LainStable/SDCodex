/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: {
          bg: '#0f131c',
          lowest: '#0a0e17',
          low: '#181b25',
          DEFAULT: '#1c1f29',
          high: '#262a34',
          highest: '#31353f',
          bright: '#353943',
        },
        ink: {
          DEFAULT: '#dfe2ef',
          muted: '#c7c4d7',
          faint: '#908fa0',
        },
        primary: {
          DEFAULT: '#6366f1',
          light: '#818cf8',
          pale: '#c0c1ff',
          container: '#8083ff',
        },
        secondary: { DEFAULT: '#06b6d4', pale: '#4cd7f6' },
        tertiary: { DEFAULT: '#8b5cf6', pale: '#d0bcff' },
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

