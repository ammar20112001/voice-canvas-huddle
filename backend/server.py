"""
WebSocket bridge between a browser mic and the voice -> diagram-schema pipeline.

  browser -> server:  binary WS frames, raw PCM16 audio (16kHz mono, any chunk size)
  server -> browser:  JSON text WS frames, {action, diagram_type, nodes, edges} -
                       the full diagram as understood so far this connection,
                       plus whether the latest utterance extended it or
                       replaced it ("extend" | "new")

Run:
  uvicorn backend.server:app --reload --port 8000
  (from the repo root, with ANTHROPIC_API_KEY set or in a .env file)
"""

import asyncio
import logging
import os
import sys
import time

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from backend.pipeline import DiagramAgent, Segmenter, Transcriber, looks_complete

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


@app.websocket("/ws/audio")
async def audio_socket(ws: WebSocket):
    await ws.accept()
    log.info("[WS] client connected")

    segmenter = Segmenter()
    pending_text = ""
    # Full diagram state as understood so far this connection - handed back
    # to the LLM each turn so it can decide whether to extend or replace it.
    current_diagram = {"diagram_type": "none", "nodes": [], "edges": []}

    try:
        while True:
            chunk = await ws.receive_bytes()
            for pcm16_bytes, duration_s in segmenter.feed(chunk):
                pipeline_t0 = time.perf_counter()

                # faster-whisper and the Anthropic client are both blocking
                # calls - run them off the event loop so other connections
                # (and this one's audio receive loop) aren't stalled.
                text = await asyncio.to_thread(_transcriber.transcribe, pcm16_bytes, duration_s)
                if not text:
                    log.info("[PIPE] empty transcription, discarding utterance")
                    continue

                combined = (pending_text + " " + text).strip() if pending_text else text
                if pending_text:
                    log.info(f"[PIPE] merged with pending text -> \"{combined}\"")

                complete, reason = looks_complete(combined)
                log.info(f"[CHECK] complete={complete} ({reason})")

                if not complete:
                    pending_text = combined
                    log.info("[PIPE] holding as pending, waiting for more speech")
                    continue

                pending_text = ""
                schema = await asyncio.to_thread(_agent.generate, combined, current_diagram)
                prev_node_count = len(current_diagram["nodes"])
                prev_edge_count = len(current_diagram["edges"])
                current_diagram = _merge_diagram(current_diagram, schema)
                total = time.perf_counter() - pipeline_t0
                log.info(
                    f"[PIPE] total time from utterance end to schema ready: {total:.2f}s, "
                    f"diagram now has {len(current_diagram['nodes'])} node(s), "
                    f"{len(current_diagram['edges'])} edge(s)"
                )

                # Not every complete-sounding fragment is drawable (small
                # talk, background context) - when the model added nothing
                # and didn't start a new diagram, there's nothing for the
                # frontend to do, so don't make it redraw/re-zoom for no
                # reason.
                changed = (
                    schema.get("action") == "new"
                    or len(current_diagram["nodes"]) != prev_node_count
                    or len(current_diagram["edges"]) != prev_edge_count
                )
                if not changed:
                    log.info("[PIPE] no drawable change, keeping diagram as is")
                    continue

                await ws.send_json({"action": schema.get("action", "new"), **current_diagram})
    except WebSocketDisconnect:
        log.info("[WS] client disconnected")
