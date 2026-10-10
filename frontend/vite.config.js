import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser only ever talks to its own origin; in dev, Vite forwards the
// two backend services. In production the reverse proxy (Caddy/nginx) does
// the same routing - keep these paths in sync with deploy/Caddyfile.
//   /api/*   -> FastAPI (rooms, Jarvis audio socket)   :8000
//   /sync/*  -> tldraw sync service (Node)             :5858
//   /livekit/* -> LiveKit signalling (docker, prefix stripped) :7880
// https://vite.dev/config/
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8000'
const sync = process.env.SYNC_URL || 'http://127.0.0.1:5858'
const livekit = process.env.LIVEKIT_URL || 'http://127.0.0.1:7880'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: backend, ws: true },
      '/sync': { target: sync, ws: true },
      '/livekit': { target: livekit, ws: true, rewrite: (path) => path.replace(/^\/livekit/, '') },
    },
  },
})
