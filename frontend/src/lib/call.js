import { createLocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client'
import { callTokenUrl, livekitUrl } from './endpoints'

// The audio call. Media goes browser <-> LiveKit directly (SFU); this app's
// own backend only mints the join token. The mic is opened ONCE, here, and
// the same MediaStream is handed to audioCapture.js so Jarvis hears exactly
// what the other participants hear (and the browser only prompts once).
//
// startCall() returns immediately; `ready` resolves with {stream} once the
// mic is published, or rejects (mic denied, LiveKit unreachable, ...) - the
// caller can then fall back to a mic-only Jarvis session.
export function startCall({ roomId, identity, name, onSpeakers, onPlaybackBlocked, onState }) {
  const room = new Room({
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let left = false
  let micTrack = null

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return
    const el = track.attach()
    el.style.display = 'none'
    document.body.appendChild(el)
  })
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((el) => el.remove())
  })
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    onSpeakers?.(new Set(speakers.map((s) => s.identity)))
  })
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    onPlaybackBlocked?.(!room.canPlaybackAudio)
  })
  room.on(RoomEvent.Disconnected, () => {
    if (!left) onState?.('disconnected')
  })
  room.on(RoomEvent.Reconnecting, () => onState?.('reconnecting'))
  room.on(RoomEvent.Reconnected, () => onState?.('connected'))

  function cleanup() {
    micTrack?.stop()
    micTrack = null
    room.disconnect()
  }

  const ready = (async () => {
    onState?.('connecting')
    const res = await fetch(callTokenUrl(roomId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity, name }),
    })
    if (!res.ok) throw new Error(`call token request failed (${res.status})`)
    const { token } = await res.json()
    if (left) return null

    await room.connect(livekitUrl, token)
    if (left) {
      cleanup()
      return null
    }

    micTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
    if (left) {
      cleanup()
      return null
    }
    await room.localParticipant.publishTrack(micTrack)
    onState?.('connected')
    return { stream: new MediaStream([micTrack.mediaStreamTrack]) }
  })()
  // Surface failures to the caller via `ready`; this just prevents an
  // "unhandled rejection" if nobody is awaiting it at that moment.
  ready.catch(() => onState?.('unavailable'))

  return {
    ready,
    room,
    // Stops what the other participants hear. (Jarvis has its own mute flag
    // in audioCapture.js; the Mute button flips both.)
    async setMuted(muted) {
      if (!micTrack) return
      if (muted) await micTrack.mute()
      else await micTrack.unmute()
    },
    // Browsers may block remote audio until a user gesture; call from a click.
    enableAudio() {
      return room.startAudio()
    },
    leave() {
      left = true
      cleanup()
    },
  }
}
