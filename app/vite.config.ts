import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin proxy for Civitai: the API's preflight rejects browser
      // Authorization headers (OPTIONS → 405), so key-authenticated calls
      // must not go cross-origin. The backend will proxy /api in prod.
      '/civitai': {
        target: 'https://civitai.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/civitai/, ''),
      },
      // Local backend (Flask). Same-origin so session cookies just work.
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
    },
  },
})
