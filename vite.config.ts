import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// https://vite.dev/config/
// Dev: proxy ALL /api/* and /config.json to the local Haven broker (npm run broker).
// Do not hit GitHub/UniFi from the browser — broker holds secrets (same as prod).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const broker = env.VITE_BROKER_URL || 'http://127.0.0.1:3000'

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
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
