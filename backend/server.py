"""
Room-based WebSocket bridge between browsers (mic + whiteboard) and the
voice -> diagram-schema pipeline.

A call is a *room*: POST /api/rooms mints an unguessable id, and anyone
who opens https://<domain>/r/<id> joins it. Each participant opens
/api/ws/rooms/<id>?name=<display name>; the whiteboard itself is NOT
carried here - it's synced by the separate Node service in sync-server/
(tldraw's multiplayer), which asks GET /api/rooms/<id> before accepting a
connection so only rooms minted here exist.

  browser -> server:  POST /api/rooms/<id>/call-token {identity, name} -> LiveKit
                       JWT for the audio call (media itself never touches this server).
  browser -> server:  binary WS frames, raw PCM16 audio (16kHz mono). Each
                       participant's mic is its own connection, so each gets
                       its own Segmenter - that's the "who said it" signal.
  browser -> server:  {"type": "diagram_edit", "diagrams": [...]} - the full
                       diagram set after a manual edit on the shared board.
                       Ignored if it matches what the room already holds
                       (the scribe's own Jarvis draws echo back this way).
  browser -> server:  {"type": "jarvis", "active": bool} - turn drawing on/off.
  browser -> server:  {"type": "undo"}
  server -> browser:  {"type": "jarvis", "active": bool} - broadcast whenever the
                       room's drawing state changes.
  server -> browser:  {"type": "room", "you": id, "scribe": id, "jarvis": bool,
                       "participants": [{id, name}]} - sent on every join/leave.
  server -> browser:  {"type": "resume", "diagrams": [...]} - to the (new)
                       scribe only, so it can restore a board that's empty.
  server -> browser:  {"action": "extend" | "new_diagram" | "replace_all", ...}
                       broadcast to the whole room. Only the *scribe* (the
                       longest-present participant) lays out and draws it
                       into the shared tldraw document; everyone else gets the
                       shapes through sync. See frontend/src/lib/diagramRender.js.

Drawing is button-gated ("Jarvis"): nothing is drawn until someone in the
room turns Jarvis on from the UI ({"type": "jarvis", "active": true}), and
it stops when anyone turns it off. The state is shared by the whole room.
Everything said while it's off is kept as background context.

Jarvis keeps a SET of independent diagrams (see SYSTEM_PROMPT in
pipeline.py). Every change goes through _set_diagrams(), which pushes the
previous state onto a history stack so "undo" always works.

Run:
  uvicorn backend.server:app --port 8000
  (from the repo root, with OPENROUTER_API_KEY or ANTHROPIC_API_KEY set or in a .env file;
   see resolve_llm_provider() in pipeline.py for how the provider is picked)
"""

import asyncio
import json
import logging
import os
import re
import secrets
import sys
import time
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from livekit import api as livekit_api

from backend.pipeline import (
    DiagramAgent,
    Segmenter,
    Transcriber,
    build_background_context,
    resolve_llm_provider,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d [%(levelname)-5s] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("voice2diagram")

app = FastAPI()

# The frontend talks to this through the same origin (Vite's dev proxy, or
# the reverse proxy in production), so CORS is off unless explicitly listed.
_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

try:
    _llm_provider, _api_key = resolve_llm_provider()
except RuntimeError as e:
    log.error(str(e))
    sys.exit(1)

# Whisper model load takes a few seconds and is CPU-bound - load once at
# startup and share across every room and speaker.
_transcriber = Transcriber()
_agent = DiagramAgent(_llm_provider, _api_key)
# One CPU model shared by every speaker in every room: serialize it rather
# than letting simultaneous speakers fight for the cores.
_transcribe_lock = asyncio.Lock()

# LiveKit (the audio call). Dev defaults match deploy/docker-compose.yml and
# are only safe on localhost - set real values in .env before exposing this.
_DEV_LIVEKIT_KEY = "devkey"
_DEV_LIVEKIT_SECRET = "devsecret-change-me-0123456789abcdef"
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", _DEV_LIVEKIT_KEY)
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", _DEV_LIVEKIT_SECRET)
if LIVEKIT_API_SECRET == _DEV_LIVEKIT_SECRET:
    log.warning("[CALL] LIVEKIT_API_SECRET is the development default - set your own before exposing this publicly")
CALL_TOKEN_TTL = timedelta(hours=6)

MAX_DIAGRAM_HISTORY = 50
MAX_ROOM_SIZE = int(os.environ.get("MAX_ROOM_SIZE", "6"))
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "50"))
ROOM_IDLE_TTL_S = 24 * 3600
ROOMS_FILE = Path(os.environ.get("ROOMS_FILE", "data/rooms.json"))


_PEER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")


class Client:
    def __init__(self, ws: WebSocket, name: str, peer_id: str | None = None):
        # The browser picks its own id and uses it as its LiveKit identity
        # too, so "who's speaking in the call" lines up with this roster.
        self.id = peer_id if peer_id and _PEER_ID_RE.match(peer_id) else secrets.token_hex(4)
        self.ws = ws
        self.name = name


class Room:
    """Everything that should survive a participant dropping and
    rejoining. One per call, keyed by the id in the join link."""

    def __init__(self, room_id: str, diagrams: list | None = None):
        self.id = room_id
        self.diagrams = diagrams or []  # list of {id, title, diagram_type, nodes, edges}
        self.diagrams_history = []  # snapshots of self.diagrams, for undo
        self.active = False
        self.transcript_log = []
        self.draw_marker_indices = []
        self.clients: list[Client] = []  # join order - clients[0] is the scribe
        self.lock = asyncio.Lock()  # serializes LLM turns so two speakers can't interleave state changes
        self.last_active = time.time()


_rooms: dict[str, Room] = {}


def _save_rooms() -> None:
    """Persists room ids and their diagrams so join links and Jarvis's
    picture survive a backend restart. Best-effort."""
    try:
        ROOMS_FILE.parent.mkdir(parents=True, exist_ok=True)
        data = {rid: {"diagrams": r.diagrams} for rid, r in _rooms.items()}
        tmp = ROOMS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(ROOMS_FILE)
    except OSError:
        log.exception("[ROOMS] failed to persist rooms")


def _load_rooms() -> None:
    try:
        data = json.loads(ROOMS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return
    for rid, saved in data.items():
        _rooms[rid] = Room(rid, saved.get("diagrams", []))
    log.info(f"[ROOMS] restored {len(_rooms)} room(s)")


_load_rooms()


def _clean_name(raw: str) -> str:
    name = re.sub(r"[^\w .'-]", "", raw or "").strip()[:40]
    return name or "Guest"


def _make_diagram_id(title: str, diagrams: list) -> str:
    """Slugifies a title into an id, disambiguating against ids already in
    use so two same-named diagrams don't collide."""
    base = re.sub(r"[^a-z0-9]+", "_", (title or "diagram").lower()).strip("_") or "diagram"
    existing_ids = {d["id"] for d in diagrams}
    candidate = base
    n = 2
    while candidate in existing_ids:
        candidate = f"{base}_{n}"
        n += 1
    return candidate


def _valid_references(references: list, diagrams: list) -> list:
    """Drops any reference to a diagram/node the model hallucinated, so a
    bad id never reaches the frontend as something to render."""
    diagrams_by_id = {d["id"]: d for d in diagrams}
    valid = []
    for ref in references or []:
        target = diagrams_by_id.get(ref.get("diagram_id"))
        if target is None:
            continue
        node_id = ref.get("node_id")
        if node_id and not any(n["id"] == node_id for n in target["nodes"]):
            node_id = None  # referenced node doesn't exist - fall back to whole-diagram
        valid.append({"diagram_id": target["id"], "node_id": node_id})
    return valid


def _new_diagram_from_schema(schema: dict, diagrams: list) -> dict:
    return {
        "id": _make_diagram_id(schema.get("title"), diagrams),
        "title": schema.get("title") or "Diagram",
        "diagram_type": schema.get("diagram_type") or "flow",
        "nodes": schema.get("nodes", []),
        "edges": schema.get("edges", []),
        "references": _valid_references(schema.get("references", []), diagrams),
    }


def _apply_llm_schema(diagrams: list, schema: dict) -> tuple[list, dict | None]:
    """Applies the LLM's decision to the diagram set. Returns
    (new_diagrams, ws_message) - ws_message is None when nothing actually
    changed (a no-op turn: small talk, or content already covered)."""
    action = schema.get("action", "extend")
    nodes = schema.get("nodes", [])
    edges = schema.get("edges", [])

    if action == "replace_all":
        if not nodes:
            return diagrams, None  # guard against an empty replace wiping everything for no reason
        new_diagram = _new_diagram_from_schema(schema, [])
        new_diagrams = [new_diagram]
        return new_diagrams, {"action": "replace_all", "diagrams": new_diagrams}

    if action == "new_diagram":
        if not nodes and not edges:
            return diagrams, None  # nothing drawable this turn
        new_diagram = _new_diagram_from_schema(schema, diagrams)
        new_diagrams = diagrams + [new_diagram]
        return new_diagrams, {"action": "new_diagram", "diagram": new_diagram}

    # action == "extend" - can add, remove, and/or rename within one
    # existing diagram, all in the same turn.
    remove_node_ids = set(schema.get("remove_node_ids") or [])
    remove_edge_pairs = {(e.get("from"), e.get("to")) for e in (schema.get("remove_edges") or [])}
    relabels = {n["id"]: n.get("label") for n in (schema.get("update_nodes") or []) if n.get("id")}

    if not nodes and not edges and not remove_node_ids and not remove_edge_pairs and not relabels:
        return diagrams, None  # nothing to do this turn

    target = next((d for d in diagrams if d["id"] == schema.get("diagram_id")), None)
    if target is None:
        if not nodes and not edges:
            # A remove/rename instruction naming a diagram that doesn't
            # exist (or no diagrams exist yet) - nothing sensible to do.
            return diagrams, None
        # The model referenced a diagram that doesn't exist for ADDING
        # content - treat it as its own new diagram rather than silently
        # dropping it.
        new_diagram = _new_diagram_from_schema(schema, diagrams)
        new_diagrams = diagrams + [new_diagram]
        return new_diagrams, {"action": "new_diagram", "diagram": new_diagram}

    existing_ids = {n["id"] for n in target["nodes"]}
    kept_nodes = []
    for n in target["nodes"]:
        if n["id"] in remove_node_ids:
            continue
        new_label = relabels.get(n["id"])
        kept_nodes.append({**n, "label": new_label} if new_label else n)
    merged_nodes = kept_nodes + [n for n in nodes if n["id"] not in existing_ids]

    def _edge_removed(e):
        return (e["from"], e["to"]) in remove_edge_pairs or e["from"] in remove_node_ids or e["to"] in remove_node_ids

    kept_edges = [e for e in target["edges"] if not _edge_removed(e)]
    merged_edges = kept_edges + edges

    if merged_nodes == target["nodes"] and merged_edges == target["edges"]:
        return diagrams, None  # nothing the model sent actually changed anything

    updated = {**target, "nodes": merged_nodes, "edges": merged_edges}
    new_diagrams = [updated if d["id"] == target["id"] else d for d in diagrams]
    return new_diagrams, {"action": "extend", "diagram": updated}


def _same_diagrams(a: list, b: list) -> bool:
    """Whether two diagram sets say the same thing - ignoring order and any
    extra fields (references, node metadata). Used to drop the echo of
    Jarvis's own draw coming back as a "manual edit"."""

    def norm(diagrams):
        out = {}
        for d in diagrams or []:
            nodes = frozenset((n["id"], n.get("label") or "") for n in d.get("nodes", []))
            edges = frozenset((e["from"], e["to"], e.get("label") or "") for e in d.get("edges", []))
            out[d["id"]] = (nodes, edges)
        return out

    try:
        return norm(a) == norm(b)
    except (KeyError, TypeError):
        return False


def _set_diagrams(room: Room, new_diagrams: list) -> None:
    """The one place room.diagrams is ever reassigned - always pushes the
    previous state onto history first, so any change (voice-driven or a
    manual edit) can be undone."""
    room.diagrams_history.append(room.diagrams)
    if len(room.diagrams_history) > MAX_DIAGRAM_HISTORY:
        room.diagrams_history.pop(0)
    room.diagrams = new_diagrams
    _save_rooms()


def _undo(room: Room) -> list | None:
    if not room.diagrams_history:
        return None
    room.diagrams = room.diagrams_history.pop()
    _save_rooms()
    log.info(f"[WS] room {room.id}: undo -> {len(room.diagrams)} diagram(s)")
    return room.diagrams


async def _send(client: Client, message: dict) -> None:
    try:
        await client.ws.send_json(message)
    except Exception:
        pass  # a dead socket gets cleaned up by its own receive loop


async def _broadcast(room: Room, message: dict) -> None:
    for client in list(room.clients):
        await _send(client, message)


async def _send_roster(room: Room) -> None:
    scribe_id = room.clients[0].id if room.clients else None
    participants = [{"id": c.id, "name": c.name} for c in room.clients]
    for client in list(room.clients):
        await _send(
            client,
            {"type": "room", "you": client.id, "scribe": scribe_id, "jarvis": room.active, "participants": participants},
        )


async def _handle_text_message(raw_text: str, room: Room, client: Client) -> None:
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        log.warning(f"[WS] malformed message, ignoring: {raw_text!r}")
        return

    msg_type = payload.get("type")

    if msg_type == "diagram_edit":
        diagrams = payload.get("diagrams", [])
        if not isinstance(diagrams, list) or _same_diagrams(diagrams, room.diagrams):
            return
        # The frontend reports the full current shape set (deletions
        # included), so this replaces outright rather than merging - a
        # merge would resurrect anything someone just deleted by hand.
        _set_diagrams(room, diagrams)
        log.info(f"[WS] room {room.id}: adopted manual edit from {client.name} - {len(diagrams)} diagram(s)")
        return

    if msg_type == "jarvis":
        active = bool(payload.get("active"))
        if active != room.active:
            room.active = active
            log.info(f"[JARVIS] room {room.id}: {client.name} turned drawing {'on' if active else 'off'}")
        # Broadcast even when unchanged so a client whose button state was
        # out of date (two people clicking at once) settles on the truth.
        await _broadcast(room, {"type": "jarvis", "active": room.active})
        return

    if msg_type == "undo":
        restored = _undo(room)
        if restored is None:
            return
        await _broadcast(room, {"action": "replace_all", "diagrams": restored})
        return

    log.warning(f"[WS] unknown message type, ignoring: {msg_type!r}")


def _prune_rooms() -> None:
    now = time.time()
    for rid in [r for r, room in _rooms.items() if not room.clients and now - room.last_active > ROOM_IDLE_TTL_S]:
        del _rooms[rid]


@app.post("/api/rooms")
def create_room():
    _prune_rooms()
    if len(_rooms) >= MAX_ROOMS:
        raise HTTPException(status_code=503, detail="too many rooms")
    room_id = secrets.token_urlsafe(9)  # 72 bits - unguessable, the link IS the credential
    _rooms[room_id] = Room(room_id)
    _save_rooms()
    log.info(f"[ROOMS] created {room_id}")
    return {"id": room_id}


@app.get("/api/rooms/{room_id}")
def get_room(room_id: str):
    room = _rooms.get(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="no such room")
    return {"id": room.id, "participants": len(room.clients), "capacity": MAX_ROOM_SIZE}


@app.post("/api/rooms/{room_id}/call-token")
def call_token(room_id: str, body: dict = Body(...)):
    """Mints a LiveKit access token for this room's audio call. Same trust
    model as the rest of the app: knowing the room id (the link) is the
    credential. `identity` is the participant's peer id (see Client)."""
    room = _rooms.get(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="no such room")
    identity = str(body.get("identity", ""))
    if not _PEER_ID_RE.match(identity):
        raise HTTPException(status_code=400, detail="bad identity")
    if len(room.clients) >= MAX_ROOM_SIZE and not any(c.id == identity for c in room.clients):
        raise HTTPException(status_code=403, detail="room is full")
    token = (
        livekit_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(_clean_name(str(body.get("name", ""))))
        .with_ttl(CALL_TOKEN_TTL)
        .with_grants(
            livekit_api.VideoGrants(
                room_join=True,
                room=room_id,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=False,
                can_publish_sources=["microphone"],  # audio-only: no camera/screen even if a client tries
            )
        )
    )
    return {"token": token.to_jwt()}


@app.websocket("/api/ws/rooms/{room_id}")
async def room_socket(ws: WebSocket, room_id: str, name: str = "", peer: str = ""):
    room = _rooms.get(room_id)
    if room is None:
        await ws.close(code=4404)
        return
    if len(room.clients) >= MAX_ROOM_SIZE:
        await ws.close(code=4403)
        return

    await ws.accept()
    client = Client(ws, _clean_name(name), peer)
    # A browser reconnecting (or React's dev double-mount) reuses its peer
    # id before the old socket has finished closing - the newest one wins,
    # so the roster never shows the same participant twice.
    for stale in [c for c in room.clients if c.id == client.id]:
        room.clients.remove(stale)
        try:
            await stale.ws.close(code=4000)
        except Exception:
            pass
    room.clients.append(client)
    room.last_active = time.time()
    log.info(f"[WS] room {room.id}: {client.name} joined ({len(room.clients)} in room)")

    await _send_roster(room)
    if room.clients[0] is client:
        await _send(client, {"type": "resume", "diagrams": room.diagrams})

    # Per-connection: audio buffering/timing has no meaning across a drop,
    # so this starts fresh every time - and being per-connection it is
    # also per-speaker.
    segmenter = Segmenter()

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            if message.get("text") is not None:
                await _handle_text_message(message["text"], room, client)
                continue

            chunk = message.get("bytes")
            if chunk is None:
                continue  # no payload on this frame - nothing to do

            # Nothing below this point should ever be allowed to kill the
            # connection - a bad audio chunk, a Whisper hiccup, or a flaky
            # Anthropic call should be logged and skipped, not drop the
            # socket.
            try:
                utterances = segmenter.feed(chunk)
            except Exception:
                log.exception("[VAD] error segmenting audio chunk - continuing")
                continue

            for pcm16_bytes, duration_s in utterances:
                try:
                    pipeline_t0 = time.perf_counter()

                    # faster-whisper and the Anthropic client are both
                    # blocking calls - run them off the event loop so other
                    # connections aren't stalled.
                    async with _transcribe_lock:
                        text = await asyncio.to_thread(_transcriber.transcribe, pcm16_bytes, duration_s)
                    if not text:
                        log.info("[PIPE] empty transcription, discarding utterance")
                        continue

                    # With more than one person in the room the model needs
                    # to know who's talking.
                    spoken = f"{client.name}: {text}" if len(room.clients) > 1 else text

                    async with room.lock:
                        if not room.active:
                            room.transcript_log.append(spoken)
                            log.info(f"[JARVIS] inactive, logged as background context: \"{spoken}\"")
                            continue

                        background_context = build_background_context(room.transcript_log, room.draw_marker_indices)
                        room.transcript_log.append(spoken)
                        schema = await asyncio.to_thread(_agent.generate, spoken, room.diagrams, background_context)
                        total = time.perf_counter() - pipeline_t0

                        new_diagrams, ws_message = _apply_llm_schema(room.diagrams, schema)
                        if ws_message is None:
                            log.info(f"[PIPE] total time: {total:.2f}s, no drawable change, keeping diagrams as is")
                            continue

                        _set_diagrams(room, new_diagrams)
                        room.draw_marker_indices.append(len(room.transcript_log))
                        log.info(
                            f"[PIPE] room {room.id}: {total:.2f}s from utterance end to schema ready, "
                            f"action={ws_message['action']}, {len(room.diagrams)} diagram(s) total"
                        )
                        await _broadcast(room, ws_message)
                except (WebSocketDisconnect, asyncio.CancelledError):
                    raise
                except Exception:
                    log.exception("[PIPE] error processing utterance - continuing")
                    continue
    except WebSocketDisconnect:
        pass
    finally:
        was_scribe = bool(room.clients) and room.clients[0] is client
        if client in room.clients:
            room.clients.remove(client)
        room.last_active = time.time()
        log.info(f"[WS] room {room.id}: {client.name} left ({len(room.clients)} in room)")
        if room.clients:
            await _send_roster(room)
            if was_scribe:
                await _send(room.clients[0], {"type": "resume", "diagrams": room.diagrams})
        else:
            # Last one out: don't carry a half-finished "listening" state
            # into whoever opens the link next.
            room.active = False
