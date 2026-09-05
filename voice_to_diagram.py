"""
Local voice -> diagram-schema pipeline (prototype, with full stage logging)

Stages:
  mic capture -> VAD segmentation (webrtcvad) -> CPU transcription (faster-whisper)
  -> regex completeness check -> LLM schema generation (Claude Haiku)

Every stage logs what it's doing and how long it took, so you can see exactly
where time goes and why an utterance was held vs sent.

Setup:
  pip install faster-whisper sounddevice "webrtcvad-wheels" numpy anthropic python-dotenv
  (macOS: brew install portaudio | Debian/Ubuntu: sudo apt install portaudio19-dev)

  Put ANTHROPIC_API_KEY=sk-ant-... in a .env file next to this script,
  or export it in your shell.
  python voice_to_diagram.py
"""

import json
import logging
import os
import queue
import re
import sys
import time

import numpy as np
import sounddevice as sd
import webrtcvad
from dotenv import load_dotenv
from faster_whisper import WhisperModel
import anthropic

load_dotenv()

# ---------------- Logging setup ----------------
# VERBOSE=True also logs individual VAD frame buffering progress (noisy but
# shows literally every ~150ms of audio as it accumulates). Turn off once
# you trust the pipeline and just want stage-level logs.
VERBOSE = True

logging.basicConfig(
    level=logging.DEBUG if VERBOSE else logging.INFO,
    format="%(asctime)s.%(msecs)03d [%(levelname)-5s] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("voice2diagram")

# ---------------- Config ----------------
SAMPLE_RATE = 16000
FRAME_MS = 30                      # webrtcvad requires 10/20/30ms frames
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
VAD_AGGRESSIVENESS = 2             # 0-3, higher = stricter about what counts as speech
SILENCE_HANG_MS = 700              # trailing silence required to end an utterance
SILENCE_HANG_FRAMES = SILENCE_HANG_MS // FRAME_MS
BUFFER_LOG_EVERY_N_FRAMES = 5      # ~150ms, only used when VERBOSE=True
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


# ---------------- Audio capture + VAD segmentation ----------------
class Segmenter:
    """Turns a raw mic stream into discrete utterances using silence detection."""

    def __init__(self):
        self.vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
        self.audio_q: "queue.Queue[bytes]" = queue.Queue()
        self.buffer = []
        self.silence_run = 0
        self.speaking = False
        self.speech_start_t = None
        self._frame_count_since_log = 0

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            log.debug(f"[AUDIO] sounddevice status flag: {status}")
        pcm16 = (indata[:, 0] * 32767).astype(np.int16).tobytes()
        self.audio_q.put(pcm16)

    def _frames(self):
        """Yield fixed-size PCM16 frames regardless of the callback's chunk size."""
        leftover = b""
        frame_bytes = FRAME_SAMPLES * 2  # int16 = 2 bytes per sample
        while True:
            leftover += self.audio_q.get()
            while len(leftover) >= frame_bytes:
                yield leftover[:frame_bytes]
                leftover = leftover[frame_bytes:]

    def run(self, on_utterance):
        log.info(
            f"[VAD] starting mic stream: {SAMPLE_RATE}Hz, {FRAME_MS}ms frames, "
            f"aggressiveness={VAD_AGGRESSIVENESS}, silence_hang={SILENCE_HANG_MS}ms"
        )
        stream = sd.InputStream(
            channels=1,
            samplerate=SAMPLE_RATE,
            callback=self._audio_callback,
            blocksize=FRAME_SAMPLES,
        )
        with stream:
            for frame in self._frames():
                is_speech = self.vad.is_speech(frame, SAMPLE_RATE)

                if is_speech and not self.speaking:
                    self.speaking = True
                    self.speech_start_t = time.perf_counter()
                    self._frame_count_since_log = 0
                    log.info("[VAD] speech started, buffering...")

                if is_speech:
                    self.silence_run = 0
                    self.buffer.append(frame)
                elif self.speaking:
                    self.buffer.append(frame)  # keep trailing silence in the clip
                    self.silence_run += 1

                if self.speaking:
                    self._frame_count_since_log += 1
                    if VERBOSE and self._frame_count_since_log >= BUFFER_LOG_EVERY_N_FRAMES:
                        buffered_ms = len(self.buffer) * FRAME_MS
                        log.debug(
                            f"[VAD] buffering... {buffered_ms}ms accumulated "
                            f"({len(self.buffer)} frames), silence_run={self.silence_run}"
                        )
                        self._frame_count_since_log = 0

                    if self.silence_run >= SILENCE_HANG_FRAMES:
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
                        on_utterance(utterance, duration_s)


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


# ---------------- Wiring it together ----------------
def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.error("ANTHROPIC_API_KEY not set in environment.")
        sys.exit(1)

    transcriber = Transcriber()
    agent = DiagramAgent(api_key)

    # Holds an incomplete utterance so the NEXT utterance gets appended to it
    # instead of being silently dropped.
    pending_text = ""

    def on_utterance(pcm16_bytes: bytes, duration_s: float):
        nonlocal pending_text
        pipeline_t0 = time.perf_counter()

        text = transcriber.transcribe(pcm16_bytes, duration_s)
        if not text:
            log.info("[PIPE] empty transcription, discarding utterance")
            return

        combined = (pending_text + " " + text).strip() if pending_text else text
        if pending_text:
            log.info(f"[PIPE] merged with pending text -> \"{combined}\"")

        complete, reason = looks_complete(combined)
        log.info(f"[CHECK] complete={complete} ({reason})")

        if not complete:
            pending_text = combined
            log.info(f"[PIPE] holding as pending, waiting for more speech")
            return

        pending_text = ""
        schema = agent.generate(combined)
        total = time.perf_counter() - pipeline_t0
        log.info(f"[PIPE] total time from utterance end to schema ready: {total:.2f}s")
        print(json.dumps(schema, indent=2))

    log.info("Listening... (Ctrl+C to stop)")
    try:
        Segmenter().run(on_utterance)
    except KeyboardInterrupt:
        log.info("Stopped.")


if __name__ == "__main__":
    main()