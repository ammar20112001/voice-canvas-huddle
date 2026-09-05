// Runs on the audio rendering thread (not the main thread), so it can't
// import app code - keep this file standalone.
//
// Buffers incoming Float32 samples into fixed-size frames and emits each as
// Int16 PCM, matching the 30ms-at-16kHz frames backend/pipeline.py's VAD
// expects. Assumes the AudioContext that owns this node was created with
// sampleRate: 16000 (see audioCapture.js) - if the browser doesn't honor
// that, these frames are still 480 samples but no longer 30ms of audio.
const FRAME_SAMPLES = 480

class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(FRAME_SAMPLES)
    this._offset = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i]
      if (this._offset === FRAME_SAMPLES) {
        this._flush()
      }
    }
    return true
  }

  _flush() {
    const pcm16 = new Int16Array(FRAME_SAMPLES)
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = Math.max(-1, Math.min(1, this._buffer[i]))
      pcm16[i] = s < 0 ? s * 32768 : s * 32767
    }
    this.port.postMessage(pcm16.buffer, [pcm16.buffer])
    this._offset = 0
  }
}

registerProcessor('pcm-worklet', PCMWorkletProcessor)
