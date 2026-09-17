import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Allow reverse-proxy / LAN hostnames (OIDC testing). Vite blocks
    // unknown Host headers by default. Lock down in production with e.g.
    // allowedHosts: ['sdcodex.example.com'].
    allowedHosts: true,
    proxy: {
      // Same-origin proxy for Civitai: the API's preflight rejects browser
      // Authorization headers (OPTIONS → 405), so key-authenticated calls
      // must not go cross-origin. The backend will proxy /api in prod.
      '/civitai': {
        target: 'https://civitai.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/civitai/, ''),
      },
      // Mirror host (same preflight constraints as civitai.com).
      '/civitai-red': {
        target: 'https://civitai.red',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/civitai-red/, ''),
      },
      // Local backend (Flask). Same-origin so session cookies just work.
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
    },
  },
})
