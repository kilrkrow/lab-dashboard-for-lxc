import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // For local dev, proxy the same paths used in production Nginx.
      // This lets you test /config.json and /api/repos without a full local Nginx.
      // Use a throwaway fine-grained PAT with minimal scopes for dev only.
      '/config.json': {
        target: 'http://localhost:8080', // point at your local proxy if you run one
        changeOrigin: true,
        // Or for direct (insecure, dev only):
        // target: 'https://raw.githubusercontent.com',
        // rewrite: (path) => path.replace(/^\/config\.json/, '/YOUR_USERNAME/YOUR_PRIVATE_REPO/main/config.json'),
      },
      '/api/repos': {
        target: 'https://api.github.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/repos/, '/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member'),
        // Prefer the local broker (`npm run broker`) for authenticated GitHub in dev.
        // If proxying GitHub directly, set Authorization on proxyReq with a throwaway PAT.
      },
    },
  },
})
