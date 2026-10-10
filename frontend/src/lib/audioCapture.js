// Captures mic audio and streams fixed-size PCM16 frames to a WebSocket as
// binary messages - the wire format backend/server.py's room socket
// (/api/ws/rooms/<id>) expects (see backend/pipeline.py's Segmenter).

const TARGET_SAMPLE_RATE = 16000

// Pass `existingStream` to tap a mic that's already open (the call's) instead
// of opening a second capture; it is then left running on stop() since the
// call owns it.
export async function startAudioCapture(ws, existingStream = null) {
  const ownsStream = !existingStream
  const stream =
    existingStream ??
    (await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    }))

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

  let muted = false
  worklet.port.onmessage = (event) => {
    if (!muted && ws.readyState === WebSocket.OPEN) {
      ws.send(event.data) // ArrayBuffer of Int16 PCM samples
    }
  }

  // Deliberately not connecting `worklet` to audioCtx.destination - we
  // don't want to play the mic back out of the speakers.
  source.connect(worklet)

  return {
    // Muting only stops audio going to Jarvis. (Once the call itself is
    // added, the same toggle should also mute the outgoing call track.)
    setMuted(value) {
      muted = value
    },
    stop() {
      worklet.port.onmessage = null
      source.disconnect()
      worklet.disconnect()
      if (ownsStream) stream.getTracks().forEach((track) => track.stop())
      audioCtx.close()
    },
  }
}
