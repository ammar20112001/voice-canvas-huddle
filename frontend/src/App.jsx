import { useCallback, useEffect, useRef, useState } from 'react'
import { Tldraw } from 'tldraw'
import { useSync } from '@tldraw/sync'
import 'tldraw/tldraw.css'
import './App.css'
import { startAudioCapture } from './lib/audioCapture'
import { startCall } from './lib/call'
import { boardHasDiagrams, renderSchema } from './lib/diagramRender'
import { watchForManualEdits } from './lib/diagramSync'
import { createRoomUrl, jarvisSocketUrl, roomApiUrl, syncUrl } from './lib/endpoints'

const NAME_KEY = 'whiteboard:name'
const FOLLOW_WINDOW_MS = 15000 // how long after a Jarvis draw a non-scribe's camera follows it
const FOLLOW_DEBOUNCE_MS = 700

// Pasted/dropped images would be inlined into the shared document for
// everyone; the board is diagram-only, so refuse them.
const noAssets = {
  upload: async () => {
    throw new Error('Image uploads are not supported on this board')
  },
  resolve: (asset) => asset.props.src,
}

function readName() {
  try {
    return localStorage.getItem(NAME_KEY) || ''
  } catch {
    return ''
  }
}

function newPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function roomIdFromPath() {
  const match = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/)
  return match ? match[1] : null
}

export default function App() {
  const roomId = roomIdFromPath()
  return roomId ? <Room roomId={roomId} /> : <Landing />
}

function Landing() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const startCall = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(createRoomUrl, { method: 'POST' })
      if (!res.ok) throw new Error(`server said ${res.status}`)
      const { id } = await res.json()
      window.location.assign(`/r/${id}`)
    } catch (err) {
      setError(`Couldn't start a call: ${err.message}`)
      setBusy(false)
    }
  }

  return (
    <div className="center-card">
      <h1>Whiteboard call</h1>
      <p>Start a call, share the link, and turn Jarvis on to have the diagram drawn for everyone as you talk.</p>
      <button className="primary" onClick={startCall} disabled={busy}>
        {busy ? 'Starting…' : 'Start a call'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// Pre-join: checks the room exists, asks for a display name, and - because
// the Join click is the user gesture browsers require - is where the mic is
// first opened.
function Room({ roomId }) {
  const [info, setInfo] = useState(null) // null=loading | {ok:true,...} | {ok:false}
  const [name, setName] = useState(readName)
  const [joined, setJoined] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(roomApiUrl(roomId))
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => !cancelled && setInfo(body ? { ok: true, ...body } : { ok: false }))
      .catch(() => !cancelled && setInfo({ ok: false }))
    return () => {
      cancelled = true
    }
  }, [roomId])

  if (joined) return <Board roomId={roomId} name={name.trim() || 'Guest'} />

  if (!info) return <div className="center-card">Checking the link…</div>
  if (!info.ok) {
    return (
      <div className="center-card">
        <h1>Call not found</h1>
        <p>This link doesn&rsquo;t match an active call.</p>
        <a href="/">Start a new one</a>
      </div>
    )
  }

  const full = info.participants >= info.capacity
  const join = (e) => {
    e.preventDefault()
    try {
      localStorage.setItem(NAME_KEY, name.trim())
    } catch {
      /* private mode - the name just won't be remembered */
    }
    setJoined(true)
  }

  return (
    <form className="center-card" onSubmit={join}>
      <h1>Join call</h1>
      <p>{info.participants === 0 ? 'Nobody is here yet.' : `${info.participants} in the call.`}</p>
      <input
        autoFocus
        placeholder="Your name"
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button className="primary" type="submit" disabled={full}>
        {full ? 'Call is full' : 'Join (uses your microphone)'}
      </button>
    </form>
  )
}

function Board({ roomId, name }) {
  const store = useSync({ uri: syncUrl(roomId), assets: noAssets })

  const editorRef = useRef(null)
  const wsRef = useRef(null)
  const captureRef = useRef(null)
  const callRef = useRef(null)
  const mutedRef = useRef(false)
  // One id per tab: the roster id AND the LiveKit identity (see endpoints.js).
  const [peerId] = useState(newPeerId)
  const stopSyncRef = useRef(null)
  const isScribeRef = useRef(false)
  const followUntilRef = useRef(0)
  const pendingRef = useRef([]) // messages that arrived before the board finished loading
  const [status, setStatus] = useState('connecting') // connecting | listening | error | closed
  const [room, setRoom] = useState(null)
  const [muted, setMuted] = useState(false)
  const [jarvisOn, setJarvisOn] = useState(false) // shared by the whole room, owned by the server
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0) // bump to reconnect
  const [callState, setCallState] = useState('connecting') // connecting | connected | reconnecting | disconnected | unavailable
  const [speaking, setSpeaking] = useState(() => new Set())
  const [playbackBlocked, setPlaybackBlocked] = useState(false)

  // Only the scribe lays out and draws - everyone else gets the shapes
  // through tldraw sync. A `resume` (sent to a new scribe) only redraws if
  // the shared board is actually empty, so a handoff never wipes anyone's
  // manual tweaks.
  const handleMessage = useCallback((msg) => {
    const editor = editorRef.current
    if (msg.type === 'room') {
      isScribeRef.current = msg.you === msg.scribe
      setRoom(msg)
      setJarvisOn(!!msg.jarvis)
      return
    }
    if (msg.type === 'jarvis') {
      setJarvisOn(!!msg.active)
      return
    }
    if (!editor) {
      pendingRef.current.push(msg)
      return
    }
    if (msg.type === 'resume') {
      if (isScribeRef.current && msg.diagrams?.length && !boardHasDiagrams(editor)) {
        renderSchema(editor, { action: 'replace_all', diagrams: msg.diagrams })
      }
      return
    }
    if (msg.action) {
      if (isScribeRef.current) renderSchema(editor, msg)
      else followUntilRef.current = Date.now() + FOLLOW_WINDOW_MS
    }
  }, [])

  const startWatcher = useCallback(() => {
    stopSyncRef.current?.()
    stopSyncRef.current = null
    const ws = wsRef.current
    if (editorRef.current && ws?.readyState === WebSocket.OPEN) {
      stopSyncRef.current = watchForManualEdits(editorRef.current, ws)
    }
  }, [])

  const handleMount = useCallback(
    (editor) => {
      editorRef.current = editor
      if (import.meta.env.DEV) window.__editor = editor // for browser tests
      try {
        editor.user.updateUserPreferences({ name })
      } catch {
        /* cursor labels fall back to tldraw's default name */
      }

      // Non-scribes' cameras follow Jarvis's drawing for a short window.
      let timer = null
      const unlisten = editor.store.listen(
        () => {
          if (isScribeRef.current || Date.now() > followUntilRef.current) return
          clearTimeout(timer)
          timer = setTimeout(() => editor.zoomToFit({ animation: { duration: 300 } }), FOLLOW_DEBOUNCE_MS)
        },
        { source: 'remote', scope: 'document' }
      )

      const queued = pendingRef.current
      pendingRef.current = []
      queued.forEach(handleMessage)
      startWatcher()

      return () => {
        clearTimeout(timer)
        unlisten()
        editorRef.current = null
      }
    },
    [name, handleMessage, startWatcher]
  )

  // The audio call. Declared before the Jarvis socket effect on purpose:
  // that one waits on callRef.current.ready for the shared mic stream.
  useEffect(() => {
    const call = startCall({
      roomId,
      identity: peerId,
      name,
      onSpeakers: setSpeaking,
      onPlaybackBlocked: setPlaybackBlocked,
      onState: setCallState,
    })
    callRef.current = call
    if (import.meta.env.DEV) window.__call = call // for browser tests
    if (mutedRef.current) call.ready.then(() => call.setMuted(true)).catch(() => {})
    return () => {
      call.leave()
      if (callRef.current === call) callRef.current = null
    }
  }, [roomId, peerId, name])

  useEffect(() => {
    const ws = new WebSocket(jarvisSocketUrl(roomId, name, peerId))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    let closedByUs = false

    ws.onopen = async () => {
      try {
        // Prefer the call's mic so there's one capture and one permission
        // prompt; if the call couldn't start (LiveKit down, ...), Jarvis
        // still works from its own mic.
        let shared = null
        try {
          shared = (await callRef.current?.ready)?.stream ?? null
        } catch (err) {
          console.warn('[app] call unavailable, Jarvis will use its own mic', err)
        }
        const capture = await startAudioCapture(ws, shared)
        capture.setMuted(mutedRef.current)
        if (closedByUs || ws.readyState !== WebSocket.OPEN) {
          capture.stop() // torn down while the mic prompt was open
          return
        }
        captureRef.current = capture
        startWatcher()
        setStatus('listening')
      } catch (err) {
        console.error('[app] mic capture failed', err)
        setStatus('error')
        ws.close()
      }
    }
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') handleMessage(JSON.parse(event.data))
    }
    ws.onerror = (err) => {
      if (!closedByUs) console.error('[app] websocket error', err)
    }
    ws.onclose = (event) => {
      stopSyncRef.current?.()
      stopSyncRef.current = null
      captureRef.current?.stop()
      captureRef.current = null
      if (closedByUs) return
      setStatus(event.code === 4403 ? 'full' : event.code === 4404 ? 'gone' : 'closed')
    }

    return () => {
      closedByUs = true
      ws.close()
    }
  }, [roomId, name, peerId, attempt, handleMessage, startWatcher])

  const toggleMute = () => {
    const next = !muted
    mutedRef.current = next
    captureRef.current?.setMuted(next) // Jarvis
    callRef.current?.setMuted(next) // the other participants
    setMuted(next)
  }

  const toggleJarvis = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'jarvis', active: !jarvisOn }))
    }
  }

  const undo = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'undo' }))
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link:', window.location.href)
    }
  }

  const scribeId = room?.scribe
  const live = status === 'listening'

  return (
    <div className="app">
      <div className="controls">
        <button onClick={copyLink}>{copied ? 'Copied!' : 'Copy invite link'}</button>
        <button onClick={toggleMute} disabled={!live}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          className={jarvisOn ? 'jarvis-on' : 'jarvis-off'}
          onClick={toggleJarvis}
          disabled={!live}
          title={jarvisOn ? 'Jarvis is drawing what\'s said - click to stop' : 'Have Jarvis draw what\'s said, for everyone'}
        >
          {jarvisOn ? '● Stop Jarvis' : 'Start Jarvis'}
        </button>
        <button onClick={undo} disabled={!live} title="Revert the last change (voice or manual)">
          Undo
        </button>
        <button onClick={() => window.location.assign('/')}>Leave</button>
        {playbackBlocked && (
          <button className="attention" onClick={() => callRef.current?.enableAudio()}>
            Enable call audio
          </button>
        )}
        <span className={`status status-call-${callState}`} title="Audio call">
          {callState === 'connected'
            ? 'call: live'
            : callState === 'unavailable'
              ? 'call: unavailable (Jarvis only)'
              : `call: ${callState}`}
        </span>
        <span className={`status status-${status}`}>
          {status === 'closed' || status === 'error' ? (
            <>
              disconnected <button
                onClick={() => {
                  setStatus('connecting')
                  setAttempt((n) => n + 1)
                }}
              >
                Reconnect
              </button>
            </>
          ) : status === 'full' ? (
            'call is full'
          ) : status === 'gone' ? (
            'call no longer exists'
          ) : (
            status
          )}
        </span>
        <span className="roster">
          {room?.participants.map((p) => (
            <span key={p.id} className={`chip${p.id === room.you ? ' chip-you' : ''}${speaking.has(p.id) ? ' chip-speaking' : ''}`} title={p.id === scribeId ? 'Draws for everyone' : undefined}>
              {p.name}
              {p.id === room.you ? ' (you)' : ''}
              {p.id === scribeId ? ' ✎' : ''}
            </span>
          ))}
        </span>
      </div>
      <div className="canvas">
        <Tldraw store={store} onMount={handleMount} />
      </div>
    </div>
  )
}
