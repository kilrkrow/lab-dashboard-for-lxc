import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        // Proxy /api/repos to GitHub (used by the GitHub Repos widget)
        '/api/repos': {
          target: 'https://api.github.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/repos/, '/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const token = env.VITE_GITHUB_TOKEN
              if (token) {
                proxyReq.setHeader('Authorization', `token ${token}`)
              }
            })
          },
        },

        // Optional: Proxy /config.json during development if you don't want to maintain a local copy
        // Point this at your private config repo (requires a PAT with Contents: Read)
        // '/config.json': {
        //   target: env.VITE_CONFIG_PROXY_TARGET || 'http://localhost:8080',
        //   changeOrigin: true,
        //   rewrite: (path) => {
        //     if (env.VITE_CONFIG_PROXY_PATH) {
        //       return env.VITE_CONFIG_PROXY_PATH
        //     }
        //     return path
        //   },
        //   configure: (proxy) => {
        //     proxy.on('proxyReq', (proxyReq) => {
        //       const token = env.VITE_GITHUB_TOKEN
        //       if (token) {
        //         proxyReq.setHeader('Authorization', `token ${token}`)
        //       }
        //     })
        //   },
        // },
      },
    },
  }
})