"""
WebSocket bridge between a browser mic/canvas and the voice -> diagram-schema
pipeline. Both message types below share the one connection - the browser
tells binary from text apart by frame type, same as this file does.

  browser -> server:  binary WS frames, raw PCM16 audio (16kHz mono, any chunk size)
  browser -> server:  JSON text WS frames, {"type": "diagram_edit", "diagrams": [...]} -
                       the full diagram set as it stands after a manual edit
                       on the canvas (drag, rename, delete, a shape drawn by
                       hand). Replaces _session.diagrams outright so
                       Jarvis's next call reflects what's actually on
                       screen.
  browser -> server:  JSON text WS frames, {"type": "undo"} - reverts to the
                       diagram set from before the last change (voice- or
                       manually-driven) and pushes it back.
  server -> browser:  JSON text WS frames, one of:
                       {"action": "extend", "diagram": {...}} - one existing
                         diagram grew; every other diagram is untouched.
                       {"action": "new_diagram", "diagram": {...}} - a fresh,
                         independent diagram was added alongside the rest.
                       {"action": "replace_all", "diagrams": [...]} - the
                         full diagram set, used for an explicit clear-and-
                         restart, an undo, and the resume-on-(re)connect
                         push below - the frontend redraws everything fresh
                         in all three cases.

Drawing is voice-gated ("Jarvis"): nothing gets drawn until the wake phrase
"Start drawing Jarvis" is heard, and drawing stops again on "Stop building
Jarvis" (see is_wake_phrase()/is_sleep_phrase() in backend/pipeline.py).
Everything said outside that window is kept as background context so Jarvis
still understands what's being discussed once it's turned on.

Jarvis keeps a SET of independent diagrams, not one big graph - see
SYSTEM_PROMPT in pipeline.py. Every change that touches _session.diagrams
goes through _set_diagrams(), which pushes the previous state onto a history
stack first, so a bad "replace_all" (misheard instruction, or a genuine
clear-everything request) is never unrecoverable - an "undo" message pops it
back.

The diagram set, transcript, and Jarvis on/off state live in a process-global
_SessionState (below), not per-connection locals - a dropped connection or a
deliberate Stop/Start from the frontend resumes the same session instead of
starting a blank one. On (re)connect, if any diagrams exist, they're sent
immediately so a freshly (re)loaded frontend can restore them.

Run:
  uvicorn backend.server:app --reload --port 8000
  (from the repo root, with ANTHROPIC_API_KEY set or in a .env file)
"""

import asyncio
import json
import logging
import os
import re
import sys
import time

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from backend.pipeline import (
    DiagramAgent,
    Segmenter,
    Transcriber,
    build_background_context,
    is_sleep_phrase,
    is_wake_phrase,
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local prototype only - tighten before deploying anywhere else
    allow_methods=["*"],
    allow_headers=["*"],
)

_api_key = os.environ.get("ANTHROPIC_API_KEY")
if not _api_key:
    log.error("ANTHROPIC_API_KEY not set in environment.")
    sys.exit(1)

# Whisper model load takes a few seconds and is CPU-bound - load once at
# startup and share across connections rather than per-socket.
_transcriber = Transcriber()
_agent = DiagramAgent(_api_key)

MAX_DIAGRAM_HISTORY = 50


class _SessionState:
    """Everything that should survive a WebSocket reconnect. Process-global
    because this prototype only ever serves one client at a time - real
    multi-client support would key this by a session id from the frontend
    instead of sharing one instance."""

    def __init__(self):
        self.diagrams = []  # list of {id, title, diagram_type, nodes, edges}
        self.diagrams_history = []  # snapshots of self.diagrams, for undo
        self.active = False
        self.transcript_log = []
        self.draw_marker_indices = []


_session = _SessionState()


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


def _new_diagram_from_schema(schema: dict, diagrams: list) -> dict:
    return {
        "id": _make_diagram_id(schema.get("title"), diagrams),
        "title": schema.get("title") or "Diagram",
        "diagram_type": schema.get("diagram_type") or "flow",
        "nodes": schema.get("nodes", []),
        "edges": schema.get("edges", []),
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

    if not nodes and not edges:
        return diagrams, None  # nothing drawable this turn

    if action == "new_diagram":
        new_diagram = _new_diagram_from_schema(schema, diagrams)
        new_diagrams = diagrams + [new_diagram]
        return new_diagrams, {"action": "new_diagram", "diagram": new_diagram}

    # action == "extend"
    target = next((d for d in diagrams if d["id"] == schema.get("diagram_id")), None)
    if target is None:
        # The model referenced a diagram that doesn't exist (bad id, or
        # there are no diagrams yet) - treat the content as its own new
        # diagram rather than silently dropping it.
        new_diagram = _new_diagram_from_schema(schema, diagrams)
        new_diagrams = diagrams + [new_diagram]
        return new_diagrams, {"action": "new_diagram", "diagram": new_diagram}

    existing_ids = {n["id"] for n in target["nodes"]}
    merged_nodes = target["nodes"] + [n for n in nodes if n["id"] not in existing_ids]
    merged_edges = target["edges"] + edges
    if len(merged_nodes) == len(target["nodes"]) and len(merged_edges) == len(target["edges"]):
        return diagrams, None  # everything the model sent was already there

    updated = {**target, "nodes": merged_nodes, "edges": merged_edges}
    new_diagrams = [updated if d["id"] == target["id"] else d for d in diagrams]
    return new_diagrams, {"action": "extend", "diagram": updated}


def _set_diagrams(new_diagrams: list) -> None:
    """The one place _session.diagrams is ever reassigned - always pushes
    the previous state onto history first, so any change (voice-driven or
    a manual edit) can be undone."""
    _session.diagrams_history.append(_session.diagrams)
    if len(_session.diagrams_history) > MAX_DIAGRAM_HISTORY:
        _session.diagrams_history.pop(0)
    _session.diagrams = new_diagrams


def _undo() -> list | None:
    if not _session.diagrams_history:
        return None
    _session.diagrams = _session.diagrams_history.pop()
    log.info(f"[WS] undo -> {len(_session.diagrams)} diagram(s)")
    return _session.diagrams


async def _handle_text_message(raw_text: str, ws: WebSocket) -> None:
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        log.warning(f"[WS] malformed message, ignoring: {raw_text!r}")
        return

    msg_type = payload.get("type")

    if msg_type == "diagram_edit":
        # The frontend reports the full current shape set (deletions
        # included), so this replaces outright rather than merging - a
        # merge would resurrect anything the user just deleted by hand.
        _set_diagrams(payload.get("diagrams", []))
        log.info(f"[WS] adopted manually edited diagram set - {len(_session.diagrams)} diagram(s)")
        return

    if msg_type == "undo":
        restored = _undo()
        if restored is None:
            log.info("[WS] undo requested but there's no history to revert to")
            return
        await ws.send_json({"action": "replace_all", "diagrams": restored})
        return

    log.warning(f"[WS] unknown message type, ignoring: {msg_type!r}")


@app.websocket("/ws/audio")
async def audio_socket(ws: WebSocket):
    await ws.accept()
    log.info("[WS] client connected")

    # Jarvis only draws between a wake phrase ("Start drawing Jarvis") and a
    # sleep phrase ("Stop building Jarvis") - see backend/pipeline.py's
    # is_wake_phrase()/is_sleep_phrase(). Everything transcribed outside
    # that window is kept as background_context instead of being drawn.
    # While active, every transcribed chunk (roughly every 5s during
    # continuous speech - see Segmenter's STREAM_FLUSH_MS - or sooner on a
    # natural pause) goes straight to the LLM; there's no local "is this a
    # complete sentence" gate holding it back. The model itself decides
    # per-turn whether a fragment is drawable yet (falling back to a no-op
    # extend when it isn't), which is both faster and more accurate than a
    # regex completeness heuristic.
    #
    # All of that state lives on the shared _session (see _SessionState),
    # not as locals here, so it survives this connection ending.
    if _session.diagrams:
        log.info(f"[WS] resuming persisted session - {len(_session.diagrams)} diagram(s), active={_session.active}")
        await ws.send_json({"action": "replace_all", "diagrams": _session.diagrams})

    # Per-connection: audio buffering/timing has no meaning across a drop,
    # so this - unlike _session - starts fresh every time.
    segmenter = Segmenter()

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            if message.get("text") is not None:
                await _handle_text_message(message["text"], ws)
                continue

            chunk = message.get("bytes")
            if chunk is None:
                continue  # no payload on this frame - nothing to do

            # Nothing below this point should ever be allowed to kill the
            # connection - a bad audio chunk, a Whisper hiccup, or a flaky
            # Anthropic call should be logged and skipped, not drop the
            # socket. Only an actual client disconnect (or task
            # cancellation, e.g. server shutdown) should end the loop.
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
                    # connections (and this one's audio receive loop) aren't
                    # stalled.
                    text = await asyncio.to_thread(_transcriber.transcribe, pcm16_bytes, duration_s)
                    if not text:
                        log.info("[PIPE] empty transcription, discarding utterance")
                        continue

                    if is_wake_phrase(text):
                        _session.transcript_log.append(text)
                        if not _session.active:
                            _session.active = True
                            log.info(f"[JARVIS] wake phrase in \"{text}\" - now active")
                        continue

                    if is_sleep_phrase(text):
                        _session.transcript_log.append(text)
                        if _session.active:
                            _session.active = False
                            log.info(f"[JARVIS] sleep phrase in \"{text}\" - now inactive")
                        continue

                    if not _session.active:
                        _session.transcript_log.append(text)
                        log.info(f"[JARVIS] inactive, logged as background context: \"{text}\"")
                        continue

                    background_context = build_background_context(_session.transcript_log, _session.draw_marker_indices)
                    _session.transcript_log.append(text)
                    schema = await asyncio.to_thread(_agent.generate, text, _session.diagrams, background_context)
                    total = time.perf_counter() - pipeline_t0

                    new_diagrams, ws_message = _apply_llm_schema(_session.diagrams, schema)
                    if ws_message is None:
                        log.info(f"[PIPE] total time: {total:.2f}s, no drawable change, keeping diagrams as is")
                        continue

                    _set_diagrams(new_diagrams)
                    _session.draw_marker_indices.append(len(_session.transcript_log))
                    log.info(
                        f"[PIPE] total time from utterance end to schema ready: {total:.2f}s, "
                        f"action={ws_message['action']}, {len(_session.diagrams)} diagram(s) total"
                    )
                    await ws.send_json(ws_message)
                except (WebSocketDisconnect, asyncio.CancelledError):
                    raise
                except Exception:
                    log.exception("[PIPE] error processing utterance - continuing")
                    continue
    except WebSocketDisconnect:
        log.info("[WS] client disconnected")
