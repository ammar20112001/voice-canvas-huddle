"""
Core voice -> diagram-schema pipeline logic, decoupled from any particular
audio transport.

Stages:
  PCM16 chunks -> VAD segmentation (webrtcvad) -> CPU transcription (faster-whisper)
  -> regex completeness check -> LLM schema generation (Claude Haiku)

Shared by:
  voice_to_diagram.py  - local mic prototype (sounddevice), reads mic directly
  backend/server.py    - WebSocket server, receives PCM16 chunks from a browser
"""

import json
import logging
import re
import time

import numpy as np
import webrtcvad
from faster_whisper import WhisperModel
import anthropic

log = logging.getLogger("voice2diagram")

# ---------------- Config ----------------
SAMPLE_RATE = 16000
FRAME_MS = 30                      # webrtcvad requires 10/20/30ms frames
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
FRAME_BYTES = FRAME_SAMPLES * 2    # int16 = 2 bytes/sample
VAD_AGGRESSIVENESS = 2             # 0-3, higher = stricter about what counts as speech
SILENCE_HANG_MS = 700              # trailing silence required to end an utterance
SILENCE_HANG_FRAMES = SILENCE_HANG_MS // FRAME_MS
WHISPER_MODEL_SIZE = "base.en"     # try "tiny.en" first if base.en feels slow on your CPU
LLM_MODEL = "claude-haiku-4-5-20251001"

TRAILING_FILLER_WORDS = {
    "and", "with", "or", "the", "a", "an", "to", "of", "in", "on", "for",
    "so", "that", "which", "but", "then", "into", "like", "as", "is", "are",
}

SYSTEM_PROMPT = """You convert a spoken instruction into a structured diagram schema.
Output ONLY valid JSON, no prose, no markdown fences, matching this shape:
{
  "diagram_type": "flow" | "mindmap" | "timeline" | "table" | "text",
  "nodes": [{"id": string, "label": string}],
  "edges": [{"from": string, "to": string, "label": string (optional)}]
}
If the instruction doesn't describe something drawable, return:
{"diagram_type": "none", "nodes": [], "edges": []}
"""


# ---------------- VAD segmentation ----------------
class Segmenter:
    """Turns a stream of arbitrary-sized PCM16 chunks into discrete utterances
    using silence detection. Chunks don't need to align to VAD frame
    boundaries (30ms @ 16kHz) - feed() buffers the remainder internally.
    """

    def __init__(self):
        self.vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
        self._leftover = b""
        self.buffer = []
        self.silence_run = 0
        self.speaking = False
        self.speech_start_t = None

    def feed(self, chunk: bytes) -> list[tuple[bytes, float]]:
        """Feed raw PCM16 bytes captured since the last call. Returns any
        utterances (pcm16_bytes, duration_s) completed as a result - usually
        zero or one, but a large chunk could complete more than one."""
        completed = []
        self._leftover += chunk
        while len(self._leftover) >= FRAME_BYTES:
            frame = self._leftover[:FRAME_BYTES]
            self._leftover = self._leftover[FRAME_BYTES:]
            result = self._process_frame(frame)
            if result is not None:
                completed.append(result)
        return completed

    def _process_frame(self, frame: bytes):
        is_speech = self.vad.is_speech(frame, SAMPLE_RATE)

        if is_speech and not self.speaking:
            self.speaking = True
            self.speech_start_t = time.perf_counter()
            log.info("[VAD] speech started, buffering...")

        if is_speech:
            self.silence_run = 0
            self.buffer.append(frame)
        elif self.speaking:
            self.buffer.append(frame)  # keep trailing silence in the clip
            self.silence_run += 1

        if self.speaking and self.silence_run >= SILENCE_HANG_FRAMES:
            utterance = b"".join(self.buffer)
            duration_s = len(self.buffer) * FRAME_MS / 1000
            wall_s = time.perf_counter() - self.speech_start_t
            log.info(
                f"[VAD] endpoint detected: {duration_s:.2f}s of audio "
                f"({len(self.buffer)} frames), {wall_s:.2f}s wall time "
                f"since speech start"
            )
            self.buffer = []
            self.speaking = False
            self.silence_run = 0
            self.speech_start_t = None
            return utterance, duration_s
        return None


# ---------------- Transcription ----------------
class Transcriber:
    def __init__(self):
        log.info(f"[ASR] loading faster-whisper model '{WHISPER_MODEL_SIZE}' on CPU (int8)...")
        t0 = time.perf_counter()
        self.model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
        log.info(f"[ASR] model loaded in {time.perf_counter() - t0:.2f}s")

    def transcribe(self, pcm16_bytes: bytes, audio_duration_s: float) -> str:
        log.info(f"[ASR] transcribing {audio_duration_s:.2f}s of audio...")
        t0 = time.perf_counter()
        audio = np.frombuffer(pcm16_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        segments, info = self.model.transcribe(audio, language="en", vad_filter=False)
        segment_list = list(segments)
        text = " ".join(seg.text.strip() for seg in segment_list).strip()
        elapsed = time.perf_counter() - t0
        rtf = elapsed / audio_duration_s if audio_duration_s > 0 else float("nan")
        log.info(
            f"[ASR] done in {elapsed:.2f}s (realtime factor {rtf:.2f}x, "
            f"{len(segment_list)} segment(s)) -> \"{text}\""
        )
        return text


# ---------------- Completeness heuristic ----------------
def looks_complete(text: str) -> tuple[bool, str]:
    """Returns (is_complete, reason) so the caller can log *why*."""
    if not text:
        return False, "empty transcript"
    word_count = len(text.split())
    if word_count < 3:
        return False, f"too short ({word_count} word(s))"
    last_word = re.sub(r"[^\w']", "", text.split()[-1]).lower()
    if last_word in TRAILING_FILLER_WORDS:
        return False, f"ends on filler word '{last_word}'"
    return True, f"ends on '{last_word}', {word_count} words total"


# ---------------- Schema generation ----------------
class DiagramAgent:
    def __init__(self, api_key: str):
        self.client = anthropic.Anthropic(api_key=api_key)

    def generate(self, instruction: str) -> dict:
        log.info(f"[LLM] sending to {LLM_MODEL}: \"{instruction}\"")
        t0 = time.perf_counter()
        resp = self.client.messages.create(
            model=LLM_MODEL,
            max_tokens=1000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": instruction}],
        )
        elapsed = time.perf_counter() - t0
        raw = resp.content[0].text.strip()
        log.info(
            f"[LLM] response in {elapsed:.2f}s "
            f"(in={resp.usage.input_tokens} tok, out={resp.usage.output_tokens} tok)"
        )
        log.debug(f"[LLM] raw response body:\n{raw}")

        cleaned = re.sub(r"^```json|```$", "", raw, flags=re.MULTILINE).strip()
        try:
            parsed = json.loads(cleaned)
            log.info(
                f"[LLM] parsed OK: type={parsed.get('diagram_type')}, "
                f"{len(parsed.get('nodes', []))} node(s), "
                f"{len(parsed.get('edges', []))} edge(s)"
            )
            return parsed
        except json.JSONDecodeError as e:
            log.warning(f"[LLM] JSON parse failed: {e}")
            return {"diagram_type": "none", "nodes": [], "edges": [], "_raw_response": raw}
