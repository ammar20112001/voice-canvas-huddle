# Running it

Local development - one command (needs Docker, `.venv`, and `npm`):

```bash
./dev.sh          # then open http://localhost:5180 ; Ctrl-C stops everything
```

Production on one machine - five pieces:

| What | Command (from repo root) | Port |
|---|---|---|
| Audio call media server (LiveKit) | `docker compose -f deploy/docker-compose.yml up -d` | 7880 (localhost), 7881/tcp, 7882/udp |
| API + Jarvis + call tokens (Python) | `.venv/bin/uvicorn backend.server:app --host 127.0.0.1 --port 8000` | 8000 |
| Whiteboard sync (Node) | `cd sync-server && npm ci && node server.js` | 5858 |
| Web app | `cd frontend && npm ci && npm run build` (static files in `dist/`) | - |
| TLS + routing | `DOMAIN=... WHITEBOARD_DIST=$PWD/frontend/dist caddy run --config deploy/Caddyfile` | 80/443 |

HTTPS is required in production: browsers refuse microphone access on plain HTTP.

## Before exposing it publicly

1. **Real LiveKit keys.** In `.env`:
   ```
   LIVEKIT_API_KEY=<random>        # e.g. openssl rand -hex 8
   LIVEKIT_API_SECRET=<random>     # e.g. openssl rand -hex 32
   ```
   Both the backend and docker-compose read these; the built-in dev
   defaults are only safe on localhost (the backend warns at startup).
2. **Advertise your public IP to call participants.** In
   `deploy/livekit.yaml` set `rtc.use_external_ip: true` (or `rtc.node_ip:
   <your public IP>`), then `docker compose -f deploy/docker-compose.yml up -d`.
3. **Router/firewall forwards to this machine:** 80/tcp, 443/tcp (Caddy),
   **7881/tcp** and **7882/udp** (call media). Nothing else needs to be
   reachable - 7880, 8000 and 5858 stay on localhost.
4. TURN relay is not enabled. If someone behind a strict corporate/mobile
   network can't connect to calls, that's the next thing to add.

## State and configuration

State lives in `data/` (room ids + diagrams in `rooms.json`, whiteboard
snapshots in `data/sync/`).

Environment (`.env`): `OPENROUTER_API_KEY` (uses
`nvidia/nemotron-3-ultra-550b-a55b:free`, override with `OPENROUTER_MODEL`)
or `ANTHROPIC_API_KEY` (Claude Haiku; force with `LLM_PROVIDER=anthropic`),
`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, `MAX_ROOM_SIZE` (default 6),
`MAX_ROOMS` (default 50), `CORS_ORIGINS` (default none - the browser only
talks same-origin).
