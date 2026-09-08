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

import difflib
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
STREAM_FLUSH_MS = 5000             # during continuous speech (no pause), flush for
                                    # transcription this often instead of waiting for silence
WHISPER_MODEL_SIZE = "base.en"     # try "tiny.en" first if base.en feels slow on your CPU
LLM_MODEL = "claude-haiku-4-5-20251001"

# Wake word for voice control of drawing - see is_wake_phrase()/is_sleep_phrase().
WAKE_WORD = "jarvis"
WAKE_WORD_SIMILARITY = 0.7          # difflib ratio threshold for a fuzzy "jarvis" match
WAKE_PHRASE_RE = re.compile(r"\bstart\w*\b.{0,12}?\bdraw\w*\b", re.IGNORECASE)
SLEEP_PHRASE_RE = re.compile(r"\bstop\w*\b.{0,12}?\bbuild\w*\b", re.IGNORECASE)

SYSTEM_PROMPT = """You are Jarvis, a diagramming assistant on a call - like a person with a
whiteboard who draws when they're told to, not someone transcribing
everything they overhear. You maintain a SET of independent structured
diagrams across a series of spoken instructions - not one big diagram.

ONLY draw in response to an actual instruction to draw, add, connect, show,
sketch, map out, or otherwise represent something. Most speech you hear is
NOT that: people explain things, think out loud, discuss, describe context,
or talk about something in passing without asking you to draw it. That is
background, not a drawing instruction, even while you're active - treat it
the same way as background_context and return the empty no-op shape (see
below). When genuinely unsure whether something was a real instruction to
draw vs. just talk, don't draw - wait for a clearer one. It's far better to
under-draw and let the next instruction clarify than to draw something
nobody actually asked for.

A messy diagram where everything got wired into one graph is a failure -
keep each diagram focused on one coherent, single-level view, small enough
to actually read (as a rough guide, once a diagram would grow past
somewhere around 8-10 nodes, look for a way to split what's being added
into its own referenced diagram instead of growing it further), and start
a new one whenever that focus would break.

Diagrams split apart for more reasons than "unrelated topic":
- Different level of abstraction on the SAME topic - a high-level overview
  and a zoomed-in, detailed view of one part of it belong in separate
  diagrams, not one diagram that mixes zoom levels. ("Now go deeper into
  how the payment step actually works" -> a new, separate diagram, not more
  nodes crammed into the existing one.)
- Different facet of the SAME topic - e.g. a conceptual/architectural view
  vs. its technical/implementation details. Separate diagrams, even though
  they're about the same thing.
- Genuinely unrelated topics - obviously separate.

When a new diagram elaborates on, zooms into, or otherwise relates to part
of an existing one, set "references" so that relationship stays visible
without merging the two into one graph (see the output shape below).

Each message gives you JSON with three fields:
  "current_diagrams": the diagrams as drawn so far - a list of
    {id, title, diagram_type, nodes, edges, references} (empty list if
    nothing has been drawn yet).
  "background_context": the transcript of everything said before this
    instruction, interleaved with checkpoint markers reading
    "[[diagram updated up to this point]]". Each marker shows exactly how
    far into the transcript things stood the moment a diagram last changed.
    Text before the LAST marker (or the whole thing, if there's no marker
    yet) is already reflected in current_diagrams - read it only for
    situational understanding, don't treat it as new material to draw.
    Text after the last marker hasn't produced any diagram change yet and
    may be directly relevant to this instruction (empty if there's no
    context at all).
  "instruction": the newest spoken instruction to incorporate.

Decide ONE of three actions:

"extend" - the instruction adds to or details an EXISTING diagram WITHOUT
  changing its level of abstraction or facet - it's still the same single
  coherent view, just more of it. Set "diagram_id" to that diagram's id.
  "nodes"/"edges" contain ONLY the new elements to add - never repeat a
  node or edge that already exists in that diagram. Pick new node ids that
  don't collide with ids already in that diagram (ids only need to be
  unique within their own diagram, not across diagrams).

"new_diagram" - the instruction is better served by its own diagram: a
  different topic, a deeper zoom into part of an existing diagram, a
  different facet of the same subject, or anything else that doesn't
  belong mixed into an existing view. Leave "diagram_id" empty, give it a
  short "title" and a "diagram_type". This is purely additive - every
  other existing diagram stays exactly as it is. When it relates to an
  existing diagram, set "references" (see below). Prefer this over
  cramming content into an existing diagram via "extend" whenever adding
  it would blur that diagram's level of detail or focus.

"replace_all" - discards every existing diagram and starts over with just
  this one. Use this ONLY when the instruction explicitly asks to clear
  everything or start completely over (e.g. "clear everything", "start
  over", "forget all of this", "erase it all"). This is destructive and
  the user may not be able to get their work back - when in doubt between
  "replace_all" and "new_diagram", always choose "new_diagram".

Output ONLY valid JSON, no prose, no markdown fences, matching this shape:
{
  "action": "extend" | "new_diagram" | "replace_all",
  "diagram_id": string,
  "title": string,
  "diagram_type": "flow" | "mindmap" | "timeline" | "table" | "text",
  "nodes": [{"id": string, "label": string}],
  "edges": [{"from": string, "to": string, "label": string (optional)}],
  "references": [{"diagram_id": string, "node_id": string (optional)}]
}

"diagram_id" is required for "extend" (the id of the diagram being
extended) and unused otherwise. "title" is used for "new_diagram" and
"replace_all" (a short name for the new diagram) and unused for "extend".
"references" is only used for "new_diagram" (omit or leave empty
otherwise): each entry points at the existing diagram (and, optionally,
the specific node within it) that this new diagram elaborates, zooms into,
or otherwise relates to. Omit "node_id" to reference the whole diagram
rather than one specific part of it. Leave "references" empty for a
genuinely unrelated new diagram.

If the instruction doesn't describe something drawable, return:
{"action": "extend", "diagram_id": "", "diagram_type": "none", "nodes": [], "edges": []}
"""


# ---------------- VAD segmentation ----------------
class Segmenter:
    """Turns a stream of arbitrary-sized PCM16 chunks into discrete utterances
    using silence detection, PLUS a periodic time-based flush (every
    STREAM_FLUSH_MS) so a long continuous stretch of speech - with no pause
    long enough to trigger silence-based endpointing - still gets
    transcribed and evaluated incrementally instead of only at the end.

    Chunks don't need to align to VAD frame boundaries (30ms @ 16kHz) -
    feed() buffers the remainder internally.
    """

    def __init__(self):
        self.vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
        self._leftover = b""
        self.buffer = []
        self.silence_run = 0
        self.speaking = False
        self.segment_start_t = None

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
            self.segment_start_t = time.perf_counter()
            log.info("[VAD] speech started, buffering...")

        if is_speech:
            self.silence_run = 0
            self.buffer.append(frame)
        elif self.speaking:
            self.buffer.append(frame)  # keep trailing silence in the clip
            self.silence_run += 1

        if not self.speaking:
            return None

        if self.silence_run >= SILENCE_HANG_FRAMES:
            return self._flush("endpoint", ends_speech=True)

        if len(self.buffer) * FRAME_MS >= STREAM_FLUSH_MS:
            # Still talking, no pause yet - flush what's buffered so far so
            # the rest of the pipeline can act on it, then keep listening.
            return self._flush("interim", ends_speech=False)

        return None

    def _flush(self, reason: str, ends_speech: bool):
        utterance = b"".join(self.buffer)
        duration_s = len(self.buffer) * FRAME_MS / 1000
        wall_s = time.perf_counter() - self.segment_start_t
        log.info(
            f"[VAD] {reason} flush: {duration_s:.2f}s of audio "
            f"({len(self.buffer)} frames), {wall_s:.2f}s wall time "
            f"since segment start"
        )
        self.buffer = []
        if ends_speech:
            self.speaking = False
            self.silence_run = 0
            self.segment_start_t = None
        else:
            # Don't touch silence_run here - a pause that was already
            # partway toward the endpoint threshold should still count
            # toward it after this flush, not get reset by it.
            self.segment_start_t = time.perf_counter()
        return utterance, duration_s


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


# ---------------- Wake / sleep phrase detection ----------------
def _mentions_wake_word(text: str) -> bool:
    """Fuzzy match instead of exact spelling - "Jarvis" is exactly the kind
    of proper noun a small ASR model mishears (Jarviss, Jarves, Jervis...)."""
    for word in re.findall(r"[a-zA-Z']+", text.lower()):
        if difflib.SequenceMatcher(None, word, WAKE_WORD).ratio() >= WAKE_WORD_SIMILARITY:
            return True
    return False


def is_wake_phrase(text: str) -> bool:
    """"Start drawing Jarvis" (tolerant of word order, verb tense, and
    misspellings of the name) - turns drawing on."""
    return bool(WAKE_PHRASE_RE.search(text)) and _mentions_wake_word(text)


def is_sleep_phrase(text: str) -> bool:
    """"Stop building Jarvis" (same tolerance as is_wake_phrase) - turns
    drawing back off."""
    return bool(SLEEP_PHRASE_RE.search(text)) and _mentions_wake_word(text)


# ---------------- Background context assembly ----------------
DRAW_CHECKPOINT_MARKER = "[[diagram updated up to this point]]"


def build_background_context(transcript_log: list[str], draw_marker_indices: list[int]) -> str:
    """Interleaves the transcript with DRAW_CHECKPOINT_MARKER at each
    recorded checkpoint, so the LLM can tell which part of the transcript
    already produced the current diagram from what's new since the last
    draw - see SYSTEM_PROMPT's description of "background_context".

    draw_marker_indices holds, for each successful draw, how many
    transcript_log entries existed at that moment (the caller records one
    via len(transcript_log) right after any draw that actually changes the
    diagram) - e.g. 3 means "the first 3 lines were available when that
    draw happened," so the marker renders right after line index 2.
    """
    lines = []
    marker_i = 0
    for i, text in enumerate(transcript_log):
        lines.append(text)
        while marker_i < len(draw_marker_indices) and draw_marker_indices[marker_i] == i + 1:
            lines.append(DRAW_CHECKPOINT_MARKER)
            marker_i += 1
    return "\n".join(lines)


# ---------------- Schema generation ----------------
class DiagramAgent:
    def __init__(self, api_key: str):
        self.client = anthropic.Anthropic(api_key=api_key)

    def generate(self, instruction: str, current_diagrams: list, background_context: str = "") -> dict:
        payload = {
            "current_diagrams": current_diagrams,
            "background_context": background_context,
            "instruction": instruction,
        }
        user_content = json.dumps(payload)
        log.info(
            f"[LLM] sending to {LLM_MODEL}: {len(current_diagrams)} existing diagram(s), "
            f"{len(background_context)} char(s) of background context -> \"{instruction}\""
        )
        log.info(
            f"[LLM] full prompt:\n--- system ---\n{SYSTEM_PROMPT}\n"
            f"--- user ---\n{json.dumps(payload, indent=2)}"
        )
        t0 = time.perf_counter()
        resp = self.client.messages.create(
            model=LLM_MODEL,
            max_tokens=1000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
        )
        elapsed = time.perf_counter() - t0
        raw = resp.content[0].text.strip()
        log.info(
            f"[LLM] response in {elapsed:.2f}s "
            f"(in={resp.usage.input_tokens} tok, out={resp.usage.output_tokens} tok)"
        )
        log.info(f"[LLM] raw response body:\n{raw}")

        cleaned = re.sub(r"^```json|```$", "", raw, flags=re.MULTILINE).strip()
        try:
            parsed = json.loads(cleaned)
            log.info(
                f"[LLM] parsed OK: action={parsed.get('action')}, diagram_id={parsed.get('diagram_id')!r}, "
                f"type={parsed.get('diagram_type')}, "
                f"{len(parsed.get('nodes', []))} node(s), "
                f"{len(parsed.get('edges', []))} edge(s)"
            )
            return parsed
        except json.JSONDecodeError as e:
            log.warning(f"[LLM] JSON parse failed: {e}")
            return {
                "action": "extend",
                "diagram_id": "",
                "diagram_type": "none",
                "nodes": [],
                "edges": [],
                "_raw_response": raw,
            }
