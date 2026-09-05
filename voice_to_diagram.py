"""
Local voice -> diagram-schema pipeline (prototype)

Stages:
  mic capture -> VAD segmentation (webrtcvad) -> CPU transcription (faster-whisper)
  -> regex completeness check -> LLM schema generation (Claude Haiku)

This intentionally stops at printing the generated JSON schema to the console.
Wiring that schema into a layout engine (dagre/ELK) and a CRDT canvas (Yjs) is
the next stage, once this loop feels fast and accurate enough on its own.

Setup:
  pip install faster-whisper sounddevice webrtcvad numpy anthropic
  (macOS: brew install portaudio | Debian/Ubuntu: sudo apt install portaudio19-dev)

  export ANTHROPIC_API_KEY=sk-ant-...
  python voice_to_diagram.py
"""

import json
import os
import queue
import re
import sys

import numpy as np
import sounddevice as sd
import webrtcvad
from faster_whisper import WhisperModel
import anthropic

# ---------------- Config ----------------
SAMPLE_RATE = 16000
FRAME_MS = 30                      # webrtcvad requires 10/20/30ms frames
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)
VAD_AGGRESSIVENESS = 2             # 0-3, higher = stricter about what counts as speech
SILENCE_HANG_MS = 700              # trailing silence required to end an utterance
SILENCE_HANG_FRAMES = SILENCE_HANG_MS // FRAME_MS
WHISPER_MODEL_SIZE = "base.en"     # try "tiny.en" first if base.en feels slow on your CPU
LLM_MODEL = "claude-haiku-4-5-20251001"

# Words an instruction is unlikely to end on if it's actually finished.
# This is the "regex completeness check" — deliberately simple, tune as you test it.
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

    def _audio_callback(self, indata, frames, time_info, status):
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
        stream = sd.InputStream(
            channels=1,
            samplerate=SAMPLE_RATE,
            callback=self._audio_callback,
            blocksize=FRAME_SAMPLES,
        )
        with stream:
            for frame in self._frames():
                is_speech = self.vad.is_speech(frame, SAMPLE_RATE)
                if is_speech:
                    self.speaking = True
                    self.silence_run = 0
                    self.buffer.append(frame)
                elif self.speaking:
                    self.buffer.append(frame)  # keep trailing silence in the clip
                    self.silence_run += 1
                    if self.silence_run >= SILENCE_HANG_FRAMES:
                        utterance = b"".join(self.buffer)
                        self.buffer = []
                        self.speaking = False
                        self.silence_run = 0
                        on_utterance(utterance)


# ---------------- Transcription ----------------
class Transcriber:
    def __init__(self):
        # int8 quantization is what makes this workable on CPU
        self.model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")

    def transcribe(self, pcm16_bytes: bytes) -> str:
        audio = np.frombuffer(pcm16_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _ = self.model.transcribe(audio, language="en", vad_filter=False)
        return " ".join(seg.text.strip() for seg in segments).strip()


# ---------------- Completeness heuristic ----------------
def looks_complete(text: str) -> bool:
    if not text or len(text.split()) < 3:
        return False  # too short to be a real instruction yet
    last_word = re.sub(r"[^\w']", "", text.split()[-1]).lower()
    return last_word not in TRAILING_FILLER_WORDS


# ---------------- Schema generation ----------------
class DiagramAgent:
    def __init__(self, api_key: str):
        self.client = anthropic.Anthropic(api_key=api_key)

    def generate(self, instruction: str) -> dict:
        resp = self.client.messages.create(
            model=LLM_MODEL,
            max_tokens=1000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": instruction}],
        )
        raw = resp.content[0].text.strip()
        raw = re.sub(r"^```json|```$", "", raw, flags=re.MULTILINE).strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"diagram_type": "none", "nodes": [], "edges": [], "_raw_response": raw}


# ---------------- Wiring it together ----------------
def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Set ANTHROPIC_API_KEY in your environment first.")
        sys.exit(1)

    transcriber = Transcriber()
    agent = DiagramAgent(api_key)

    # Holds an incomplete utterance so the NEXT utterance gets appended to it
    # instead of being silently dropped (see note below).
    pending_text = ""

    def on_utterance(pcm16_bytes: bytes):
        nonlocal pending_text
        text = transcriber.transcribe(pcm16_bytes)
        if not text:
            return

        combined = (pending_text + " " + text).strip() if pending_text else text
        print(f"\n[heard] {text}")

        if not looks_complete(combined):
            pending_text = combined
            print(f"[waiting] holding as incomplete: \"{combined}\"")
            return

        pending_text = ""
        print(f"[complete] \"{combined}\"")
        print("[generating schema...]")
        schema = agent.generate(combined)
        print(json.dumps(schema, indent=2))

    print("Listening... (Ctrl+C to stop)")
    try:
        Segmenter().run(on_utterance)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
