import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Dev: proxy ALL /api/* and /config.json to the local Haven broker (npm run broker).
// Do not hit GitHub/UniFi from the browser — broker holds secrets (same as prod).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const broker = env.VITE_BROKER_URL || 'http://127.0.0.1:3000'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: broker,
          changeOrigin: true,
        },
        '/config.json': {
          target: broker,
          changeOrigin: true,
        },
      },
    },
  }
})
