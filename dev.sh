#!/usr/bin/env bash
# Starts everything for local development and stops it all on Ctrl-C:
#   LiveKit (docker) - audio call media server        :7880/7881/7882
#   FastAPI backend  - rooms, Jarvis, call tokens      :8010
#   tldraw sync      - shared whiteboard (Node)        :5868
#   Vite             - the web app                     :5180
# Open http://localhost:5180
# Ports are non-default on purpose (8000/5173 are commonly taken); override
# with BACKEND_PORT / SYNC_PORT / WEB_PORT.
set -euo pipefail
cd "$(dirname "$0")"

BACKEND_PORT="${BACKEND_PORT:-8010}"
SYNC_PORT="${SYNC_PORT:-5868}"
WEB_PORT="${WEB_PORT:-5180}"
PIDS=()

cleanup() {
  echo; echo "stopping..."
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  docker compose -f deploy/docker-compose.yml stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for port in "$BACKEND_PORT" "$SYNC_PORT" "$WEB_PORT"; do
  if ss -ltn | awk '{print $4}' | grep -q ":$port$"; then
    echo "port $port is already in use - stop whatever holds it or set BACKEND_PORT/SYNC_PORT/WEB_PORT" >&2
    exit 1
  fi
done

[ -d sync-server/node_modules ] || (cd sync-server && npm ci)
[ -d frontend/node_modules ] || (cd frontend && npm ci)

docker compose -f deploy/docker-compose.yml up -d
.venv/bin/uvicorn backend.server:app --port "$BACKEND_PORT" & PIDS+=($!)
(cd sync-server && BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" SYNC_PORT="$SYNC_PORT" exec node server.js) & PIDS+=($!)
(cd frontend && BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" SYNC_URL="http://127.0.0.1:$SYNC_PORT" exec npx vite --port "$WEB_PORT" --strictPort) & PIDS+=($!)

echo "open http://localhost:$WEB_PORT  (Ctrl-C stops everything)"
wait
