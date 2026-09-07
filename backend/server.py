"""
WebSocket bridge between a browser mic/canvas and the voice -> diagram-schema
pipeline. Both message types below share the one connection - the browser
tells binary from text apart by frame type, same as this file does.

  browser -> server:  binary WS frames, raw PCM16 audio (16kHz mono, any chunk size)
  browser -> server:  JSON text WS frames, {nodes, edges} - the diagram as it
                       stands after a manual edit on the canvas (drag,
                       rename, delete, a shape drawn by hand). Replaces
                       current_diagram outright so Jarvis's next call
                       reflects what's actually on screen.
  server -> browser:  JSON text WS frames, {action, diagram_type, nodes, edges} -
                       the full diagram as understood so far this connection,
                       plus whether the latest utterance extended it or
                       replaced it ("extend" | "new")

Drawing is voice-gated ("Jarvis"): nothing gets drawn until the wake phrase
"Start drawing Jarvis" is heard, and drawing stops again on "Stop building
Jarvis" (see is_wake_phrase()/is_sleep_phrase() in backend/pipeline.py).
Everything said outside that window is kept as background context so Jarvis
still understands what's being discussed once it's turned on.

The diagram, transcript, and Jarvis on/off state live in a process-global
_SessionState (below), not per-connection locals - a dropped connection or a
deliberate Stop/Start from the frontend resumes the same session instead of
starting a blank one. On (re)connect, if a diagram already exists, it's sent
immediately so a freshly (re)loaded frontend can restore it.

Run:
  uvicorn backend.server:app --reload --port 8000
  (from the repo root, with ANTHROPIC_API_KEY set or in a .env file)
"""

import asyncio
import json
import logging
import os
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


class _SessionState:
    """Everything that should survive a WebSocket reconnect. Process-global
    because this prototype only ever serves one client at a time - real
    multi-client support would key this by a session id from the frontend
    instead of sharing one instance."""

    def __init__(self):
        self.current_diagram = {"diagram_type": "none", "nodes": [], "edges": []}
        self.active = False
        self.transcript_log = []
        self.draw_marker_indices = []


_session = _SessionState()


def _merge_diagram(current: dict, schema: dict) -> dict:
    """Applies the LLM's action to the running diagram state. "extend" trusts
    the model to have sent only new nodes/edges (deduped defensively by id
    in case it didn't); "new" replaces the diagram outright."""
    if schema.get("action") != "extend":
        return {
            "diagram_type": schema.get("diagram_type", "none"),
            "nodes": schema.get("nodes", []),
            "edges": schema.get("edges", []),
        }

    existing_ids = {n["id"] for n in current["nodes"]}
    merged_nodes = current["nodes"] + [n for n in schema.get("nodes", []) if n["id"] not in existing_ids]
    merged_edges = current["edges"] + schema.get("edges", [])
    diagram_type = schema.get("diagram_type") or current["diagram_type"]
    if diagram_type == "none" and current["diagram_type"] != "none":
        diagram_type = current["diagram_type"]

    return {"diagram_type": diagram_type, "nodes": merged_nodes, "edges": merged_edges}


def _apply_diagram_edit(raw_text: str) -> None:
    """Adopts a diagram snapshot the frontend sends after a manual canvas
    edit - replaces _session.current_diagram outright (not merged, unlike
    _merge_diagram's "extend": the frontend already reports the full
    current shape set, deletions included, so a merge would resurrect
    anything the user just deleted) so Jarvis's next call reflects what's
    actually on screen instead of drifting from it."""
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        log.warning(f"[WS] malformed diagram edit payload, ignoring: {raw_text!r}")
        return

    _session.current_diagram = {
        "diagram_type": payload.get("diagram_type", _session.current_diagram["diagram_type"]),
        "nodes": payload.get("nodes", []),
        "edges": payload.get("edges", []),
    }
    log.info(
        f"[WS] adopted manually edited diagram - {len(_session.current_diagram['nodes'])} "
        f"node(s), {len(_session.current_diagram['edges'])} edge(s)"
    )


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
    if _session.current_diagram["nodes"]:
        log.info(
            f"[WS] resuming persisted session - {len(_session.current_diagram['nodes'])} "
            f"node(s), active={_session.active}"
        )
        await ws.send_json({"action": "new", **_session.current_diagram})

    # Per-connection: audio buffering/timing has no meaning across a drop,
    # so this - unlike _session - starts fresh every time.
    segmenter = Segmenter()

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            if message.get("text") is not None:
                _apply_diagram_edit(message["text"])
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
                    schema = await asyncio.to_thread(_agent.generate, text, _session.current_diagram, background_context)
                    prev_node_count = len(_session.current_diagram["nodes"])
                    prev_edge_count = len(_session.current_diagram["edges"])
                    _session.current_diagram = _merge_diagram(_session.current_diagram, schema)
                    total = time.perf_counter() - pipeline_t0
                    log.info(
                        f"[PIPE] total time from utterance end to schema ready: {total:.2f}s, "
                        f"diagram now has {len(_session.current_diagram['nodes'])} node(s), "
                        f"{len(_session.current_diagram['edges'])} edge(s)"
                    )

                    # Not every complete-sounding fragment is drawable (small
                    # talk, background context) - when the model added
                    # nothing and didn't start a new diagram, there's
                    # nothing for the frontend to do, so don't make it
                    # redraw/re-zoom for no reason.
                    changed = (
                        schema.get("action") == "new"
                        or len(_session.current_diagram["nodes"]) != prev_node_count
                        or len(_session.current_diagram["edges"]) != prev_edge_count
                    )
                    if not changed:
                        log.info("[PIPE] no drawable change, keeping diagram as is")
                        continue

                    _session.draw_marker_indices.append(len(_session.transcript_log))
                    await ws.send_json({"action": schema.get("action", "new"), **_session.current_diagram})
                except (WebSocketDisconnect, asyncio.CancelledError):
                    raise
                except Exception:
                    log.exception("[PIPE] error processing utterance - continuing")
                    continue
    except WebSocketDisconnect:
        log.info("[WS] client disconnected")
