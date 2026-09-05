// Captures mic audio and streams fixed-size PCM16 frames to a WebSocket as
// binary messages - the wire format backend/server.py's /ws/audio endpoint
// expects (see backend/pipeline.py's Segmenter).

const TARGET_SAMPLE_RATE = 16000

export async function startAudioCapture(ws) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: TARGET_SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  if (audioCtx.sampleRate !== TARGET_SAMPLE_RATE) {
    // Not all browsers honor the requested sampleRate. When they don't, the
    // worklet's 480-sample frames no longer equal 30ms and the backend's
    // VAD (which requires exact 10/20/30ms frames) will misbehave - log
    // loudly rather than silently shipping bad audio.
    console.warn(
      `[audio] AudioContext gave ${audioCtx.sampleRate}Hz, not the requested ` +
        `${TARGET_SAMPLE_RATE}Hz - VAD frame sizing on the backend will be off.`
    )
  }

  await audioCtx.audioWorklet.addModule(new URL('../worklets/pcm-worklet.js', import.meta.url))

  const source = audioCtx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-worklet')

  worklet.port.onmessage = (event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(event.data) // ArrayBuffer of Int16 PCM samples
    }
  }

  // Deliberately not connecting `worklet` to audioCtx.destination - we
  // don't want to play the mic back out of the speakers.
  source.connect(worklet)

  return function stopAudioCapture() {
    worklet.port.onmessage = null
    source.disconnect()
    worklet.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    audioCtx.close()
  }
}
