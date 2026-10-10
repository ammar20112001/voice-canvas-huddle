# Running it

Three processes plus a reverse proxy, all on one machine:

| What | Command (from repo root) | Port |
|---|---|---|
| API + Jarvis (Python) | `.venv/bin/uvicorn backend.server:app --host 127.0.0.1 --port 8000` | 8000 |
| Whiteboard sync (Node) | `cd sync-server && npm ci && node server.js` | 5858 |
| Frontend | dev: `cd frontend && npm run dev` (proxies `/api`, `/sync`) - prod: `npm run build`, served by Caddy | 5173 |
| TLS + routing | `DOMAIN=... WHITEBOARD_DIST=$PWD/frontend/dist caddy run --config deploy/Caddyfile` | 80/443 |

HTTPS is required in production: browsers refuse microphone access on plain HTTP.

State lives in `data/` (room ids + diagrams in `rooms.json`, whiteboard
snapshots in `data/sync/`). Environment: `OPENROUTER_API_KEY` (uses `nvidia/nemotron-3-ultra-550b-a55b:free`, override with `OPENROUTER_MODEL`) or `ANTHROPIC_API_KEY` (Claude Haiku; force with `LLM_PROVIDER=anthropic`),
`MAX_ROOM_SIZE` (default 6), `MAX_ROOMS` (default 50), `CORS_ORIGINS`
(default none - the browser only talks same-origin).
